// pages/chat/chat.js
// 聊天页：云函数 + 轮询收发消息
const { formatMsgTime, formatPrice } = require('../../utils/util');
const { DEFAULT_AVATAR, CLOUD_PATH } = require('../../utils/cloud-config');

// 轮询间隔（毫秒）
//
// 为什么是 2500 而不是 500：对面是个人，不是服务器。他读完、想、打字，
// 一轮下来好几秒。把间隔压到 500 只会让云函数调用量翻五倍，
// 而用户几乎感觉不到那两秒的差别 —— 花钱买不到体验。
const POLL_INTERVAL = 2500;

// 距上次拉取超过这么久，就当作「断线重连」，按首屏整段重拉。
//
// 为什么需要它：增量拉取只带回来比 since 更新的消息，单次上限 30 条。
// 页面在后台待了半小时，中间积压了 50 条，增量拉取只会拿到最新 30 条，
// 而本地会把 lastTime 推到最新那条 —— 中间漏掉的 20 条【永远补不回来】，
// 用户看到的是一个前后接不上的对话，而且没有任何报错。
const RESYNC_GAP = 5 * 60 * 1000;

// 发图片前的体积上限
//
// 【为什么要卡在 900K 而不是 1M】
//   服务端的 imgSecCheck 硬卡 1M。这里留 100K 余量，
//   是因为同一张图在本地算出来的字节数和服务端下载到的可能有细微出入
//   （编码、元数据）。卡在正 1M 上，会出现「本地测着刚好过、
//   传上去被拒」的情况 —— 那时用户已经白等了一次上传，
//   校园网下重则十几秒。
const IMG_UPLOAD_MAX = 900 * 1024;

// 服务端只认这几种后缀（见 cloudfunctions/chat/index.js 的 IMG_EXT_MIME）。
// 客户端命名时用它兜底：临时文件路径万一取不到后缀，
// 就按 jpg 存 —— 否则会被服务端按「格式不支持」拒掉，
// 而那个提示听起来像用户选了张怪图，其实是这里没取到后缀。
const IMG_EXT_OK = ['png', 'jpg', 'jpeg', 'gif', 'bmp'];

Page({

  data: {
    conversationId: '',
    messages: [],
    inputText: '',
    sending: false,
    loading: true,
    // 顶部商品卡片
    goodsId: '',
    goodsTitle: '',
    goodsImage: '',
    goodsPrice: '',
    // 对方头像。为空时由 WXML 兜底显示默认头像
    peerAvatar: '',
    // 默认头像。WXML 里读不到 require 进来的常量，只能挂到 data 上再引用
    defaultAvatar: DEFAULT_AVATAR,
    // scroll-view 靠它滚动到某条消息。值是消息的 id，所以每条新消息
    // 都会产生一个新值，滚动一定会触发（值不变时不触发，不用额外 toggle）
    scrollIntoView: ''
  },

  onLoad(options) {
    const id = (options && options.id) || '';
    if (!id) {
      wx.showToast({ title: '会话不存在', icon: 'none' });
      this.setData({ loading: false });
      return;
    }

    // 下面三个【故意不放进 data】。
    // 它们每 2.5 秒就变一次，挂在 data 上等于每 2.5 秒做一次无谓的
    // setData 重渲染（setData 是跨线程通信，是这个小程序里最贵的操作）。
    // 挂在实例上，改它们不会惊动视图层。
    this.lastTime = 0; // 已拉到的最后一条消息的时间戳
    this.timer = null; // 轮询定时器
    this.polling = false; // 有请求在飞，别叠加
    this.loadedOnce = false;

    this.setData({ conversationId: id });
    this.loadMessages(true);
    this.startPoll();
  },

  // ============================================================
  // 轮询的开关
  // ============================================================
  //
  // 【不清定时器的后果很隐蔽】：退出聊天页之后它还在跑，
  // 每 2.5 秒打一次云函数 —— 一直耗电、耗流量、烧云函数调用量，
  // 而界面上完全看不出来。等账单出来才知道。
  //
  // onHide 和 onUnload 都要挂：navigateTo 去别的页面只触发 onHide，
  // 返回上一页才触发 onUnload，少挂一个就漏一种情况。
  // 两个都调 stopPoll，重复调用是安全的（有 timer 判空）。
  onShow() {
    if (!this.data.conversationId) return;
    if (!this.loadedOnce) return; // 首次进页由 onLoad 负责，别拉两次
    this.startPoll();
    this.loadMessages(false);
  },

  onHide() {
    this.stopPoll();
  },

  onUnload() {
    this.stopPoll();
  },

  startPoll() {
    if (this.timer) return;
    this.timer = setInterval(() => this.loadMessages(false), POLL_INTERVAL);
  },

  stopPoll() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  },

  // ============================================================
  // 拉消息
  // ============================================================
  //
  // isFirst = true  首屏，整段重拉
  // isFirst = false 轮询，只拉增量
  loadMessages(isFirst) {
    // 上一轮还没回来就跳过这一轮。
    // 网络慢的时候轮询会比请求还快，请求越堆越多，而且回来的顺序是乱的 ——
    // 聊天记录会突然倒着长出一截。
    if (this.polling) return;
    this.polling = true;

    const stale = !this.lastTime || Date.now() - this.lastTime > RESYNC_GAP;
    const full = isFirst || stale;
    const since = full ? 0 : this.lastTime;

    wx.cloud
      .callFunction({
        name: 'chat',
        data: {
          action: 'pullMessages',
          conversationId: this.data.conversationId,
          since
        }
      })
      .then((res) => {
        const r = (res && res.result) || {};
        if (r.code !== 0) {
          // 出错就停轮询。不停的话这个 toast 每 2.5 秒弹一次，
          // 用户被弹到没法用，而且根本不知道发生了什么。
          this.stopPoll();
          this.setData({ loading: false });
          if (full) wx.showToast({ title: r.message || '加载失败', icon: 'none' });
          return;
        }
        this.applyMessages(r, full);
      })
      .catch((err) => {
        // 网络抖动【不打断轮询】：下一轮自己会补上。
        // 这里要是停了，地铁里过一次隧道就得重进页面。
        console.warn('拉取消息失败：', err);
      })
      .then(() => {
        this.polling = false;
      });
  },

  applyMessages(r, full) {
    const incoming = (r.list || []).map((m) => ({
      id: m.id,
      content: m.content,
      // type 默认成 text：老消息没有这个字段（加图片之前发的），
      // 它们本来就都是文字。不给默认值的话，前端会掉进「既不是
      // image 也不是 text」的空档，气泡里什么都没有。
      type: m.type || 'text',
      // 图片消息的云存储地址。老消息是 undefined，补成空串，
      // WXML 里判断真假时不用再区分 undefined 和 ''
      fileID: m.fileID || '',
      isMine: !!m.isMine,
      // 日期 + 时分。今天的不带日期，非今天的带 —— 见 util.js 里
      // formatMsgTime 的说明。
      timeText: formatMsgTime(m.createTime)
    }));

    let messages;
    if (full) {
      messages = incoming;
    } else {
      // 按 id 去重。必须做：轮询的时间边界上，一条消息
      // 可能被前后两轮各拉回来一次，不去重就会显示两遍。
      // 自己刚发的那条也在里面 —— sendMessage 成功后我已经
      // 拿服务端给的 _id 插进列表了，这一轮再拉回来靠 id 对上，跳过。
      const seen = {};
      this.data.messages.forEach((m) => {
        seen[m.id] = true;
      });
      messages = this.data.messages.concat(incoming.filter((m) => !seen[m.id]));
    }

    // lastTime 只认【服务端返回的 createTime】，不认本地 Date.now()。
    // 手机时钟比服务器快几秒的话，用本地时间当 since 会永远大于
    // 服务器上那条新消息的时间 —— 那条消息【永远拉不到】，
    // 而且不报任何错，就像对方没回过一样。这种 bug 极难查。
    const last = (r.list || [])[r.list.length - 1];
    if (last && last.createTime) {
      const t = new Date(last.createTime).getTime();
      if (!isNaN(t) && t > this.lastTime) this.lastTime = t;
    }

    const patch = { messages, loading: false };
    if (r.peerAvatar !== undefined) patch.peerAvatar = r.peerAvatar || '';
    if (r.goodsId) {
      patch.goodsId = r.goodsId;
      patch.goodsTitle = r.goodsTitle || '';
      patch.goodsImage = r.goodsImage || '';
      // 顶部商品条的价格也要格式化。这里的 goodsPrice 是【会话创建那一刻的
      // 商品快照】，商品早就可能被改成 1e25 这种脏数据，而这个快照永远不会变。
      patch.goodsPrice = formatPrice(r.goodsPrice);
    }

    this.setData(patch, () => {
      this.loadedOnce = true;
      // 有新消息才滚。每轮无脑滚会把正在往上翻旧记录的人
      // 一把拽回底部 —— 这是聊天界面最招人烦的行为之一。
      if (incoming.length) this.scrollToBottom();
    });

    // 清零未读。
    //
    // 只在【对方的消息刚拉进来】时才调 —— 不能写成「列表里有消息就调」，
    // 那样每 2.5 秒都会打一次云函数，白烧一倍的调用量，
    // 而且清的是一个本来就是 0 的数字。自己发消息触发的轮询也不该算数。
    const hasPeerMessage = incoming.some((m) => !m.isMine);
    if (hasPeerMessage) this.markRead();
  },

  scrollToBottom() {
    const list = this.data.messages;
    if (!list.length) return;
    const last = list[list.length - 1];
    this.setData({ scrollIntoView: 'msg-' + last.id });
  },

  markRead() {
    wx.cloud
      .callFunction({
        name: 'chat',
        data: { action: 'markRead', conversationId: this.data.conversationId }
      })
      .catch((err) => console.warn('标记已读失败：', err));
  },

  // ============================================================
  // 发消息
  // ============================================================
  onInput(e) {
    this.setData({ inputText: e.detail.value });
  },

  onSend() {
    const content = (this.data.inputText || '').trim();
    // 空消息不拦的话会往数据库里塞一堆空白记录
    if (!content) return;
    // 防连点。发送是【没有幂等性】的操作，点两下就是两条，
    // 群里刷屏和被封号之间就隔着这一行。
    if (this.data.sending) return;

    this.setData({ sending: true });

    wx.cloud
      .callFunction({
        name: 'chat',
        data: {
          action: 'sendMessage',
          conversationId: this.data.conversationId,
          content
        }
      })
      .then((res) => {
        const r = (res && res.result) || {};
        if (r.code !== 0) {
          // 失败【不清空输入框】。
          // 清掉的话用户刚打的一段话就没了，得重打一遍 ——
          // 而失败原因可能只是一次网络抖动。
          // 内容违规（87014）也走这里，云函数返回的 message 已经
          // 说清楚是措辞的问题，照着提示改就行。
          wx.showToast({ title: r.message || '发送失败', icon: 'none' });
          return;
        }

        // 成功：清空输入框，并把这条插进列表
        this.setData({ inputText: '' });
        this.appendMine(r);
      })
      .catch((err) => {
        console.error('发送失败：', err);
        wx.showToast({ title: '网络异常，请重试', icon: 'none' });
      })
      .then(() => {
        this.setData({ sending: false });
      });
  },

  // 把自己刚发出去的一条插进列表
  //
  // 【为什么要立刻插，不等下一轮轮询】
  //   轮询 2.5 秒一轮。干等的话自己发的消息要 2~3 秒才出现，
  //   用户会以为没发出去，然后再点一次 —— 于是对方收到两条。
  //   靠服务端返回的 _id 插进去，下一轮轮询拉回来时按 id 对上，跳过。
  //
  // 文字和图片共用这一份：分成两份写的话，将来改「插入后要不要滚到底」
  // 这种逻辑，就会只改到其中一条路。
  appendMine(r) {
    const mine = {
      id: r._id,
      content: r.content || '',
      type: r.type || 'text',
      fileID: r.fileID || '',
      isMine: true,
      timeText: formatMsgTime(r.createTime)
    };

    this.setData({ messages: this.data.messages.concat([mine]) }, () => this.scrollToBottom());

    // 把 lastTime 推到这条消息的时间。
    // 不推的话下一轮增量拉取会【把自己刚发的这条又拉回来】——
    // 好在 applyMessages 里按 id 去重了，不会显示两遍，
    // 但每次多发一条都会多传一次数据，纯浪费。
    if (r.createTime) {
      const t = new Date(r.createTime).getTime();
      if (!isNaN(t) && t > this.lastTime) this.lastTime = t;
    }
  },

  // ============================================================
  // 发图片
  // ============================================================
  //
  // 整条链路是【先上传，再发消息】两步，顺序不能反：
  //   ① wx.cloud.uploadFile 把本地图传到云存储，拿到 fileID
  //   ② 带着 fileID 调云函数的 sendMessage，由服务端做图片安全检测
  // 反过来是做不到的 —— 云函数要先有 fileID 才能把文件下载下来检测。
  //
  // 所以「检测不通过」这件事发生时，图【已经在云存储里了】。
  // 清理是服务端的事（cloudfunctions/chat/index.js 的
  // deleteRejectedImage），客户端不用管。
  onChooseImage() {
    // 复用发送中的锁。连点两下选两张图同时上传，
    // 会并发两次 sendMessage，列表里插进两条没有顺序保证的消息。
    if (this.data.sending) return;

    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      // compressed 让微信先压一道。它只是「比原图小」，
      // 不保证到 1M 以内，所以下面还要自己压一次、量一次。
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        if (!file || !file.tempFilePath) return;
        this.compressThenUpload(file.tempFilePath);
      },
      // 用户点「取消」也会走 fail，这是正常操作，不该弹错误提示。
      // 留个空函数是【故意的】，不是忘了写。
      fail: () => {}
    });
  },

  compressThenUpload(src) {
    wx.compressImage({
      src,
      quality: 60,
      success: (r) => this.checkSizeThenUpload(r.tempFilePath || src),
      // compressImage 对某些格式（部分 png）会失败。失败不是错误，
      // 退回原图让下面的体积检查去决定 —— 直接放弃的话，
      // 用户看到的是「选完图片什么都没发生」。
      fail: () => this.checkSizeThenUpload(src)
    });
  },

  checkSizeThenUpload(filePath) {
    wx.getFileSystemManager().getFileInfo({
      filePath,
      success: (info) => {
        if (info.size > IMG_UPLOAD_MAX) {
          wx.showToast({ title: '图片太大，请换一张小一点的', icon: 'none' });
          return;
        }
        this.uploadAndSend(filePath);
      },
      // 读不到体积就放行，交给服务端去拦。
      // 这里可以放心 fail-open：服务端是 fail-closed 的
      // （超过 1M 直接拒），所以最坏结果只是白传一次，
      // 不会让一张没检测的图混进去。
      fail: () => this.uploadAndSend(filePath)
    });
  },

  uploadAndSend(filePath) {
    let ext = (filePath.split('.').pop() || '').toLowerCase();
    // 取不到后缀、或者取到一个服务端不认的（比如 .heic），
    // 一律按 jpg 命名 —— 服务端只认白名单里的后缀。
    if (IMG_EXT_OK.indexOf(ext) < 0) ext = 'jpg';

    // 路径必须以 chat/ 开头：服务端的 validChatImageFile 只认这个目录，
    // 传别处会被拒。前缀本身取自 utils/cloud-config.js 的 CLOUD_PATH.CHAT_IMAGE，
    // 不在这里写死 —— 那是客户端和服务端唯一约定好的那个字符串。
    //
    // 按会话分目录，找起来直观；文件名用时间戳 + 随机数，
    // 【不用 openid】：云存储的路径是能被看到的，
    // 把 openid 写进文件名等于到处留身份标识。
    const name = Date.now() + '-' + Math.floor(Math.random() * 1000000) + '.' + ext;
    const cloudPath = CLOUD_PATH.CHAT_IMAGE + this.data.conversationId + '/' + name;

    this.setData({ sending: true });
    wx.showLoading({ title: '发送中', mask: true });

    wx.cloud
      .uploadFile({ cloudPath, filePath })
      .then((res) => this.sendImageMessage(res.fileID))
      .catch((err) => {
        console.error('上传聊天图片失败：', err);
        wx.showToast({ title: '图片上传失败，请重试', icon: 'none' });
      })
      .then(() => {
        wx.hideLoading();
        this.setData({ sending: false });
      });
  },

  sendImageMessage(fileID) {
    return wx.cloud
      .callFunction({
        name: 'chat',
        data: {
          action: 'sendMessage',
          conversationId: this.data.conversationId,
          type: 'image',
          fileID
        }
      })
      .then((res) => {
        const r = (res && res.result) || {};
        if (r.code !== 0) {
          // 服务端返回的 message 已经说清楚是哪一类问题
          // （太大 / 涉嫌违规 / 格式不支持），照搬给用户就行。
          wx.showToast({ title: r.message || '图片发送失败', icon: 'none' });
          return;
        }
        this.appendMine(r);
      });
  },

  // 点图片看大图
  //
  // 用 index 定位而不是 data-fileid：glass-easel 下自定义组件上的
  // data-* 不可靠（goods-card 为此改成了 triggerEvent）。
  // 这里虽然只是普通 image 节点、风险小得多，但 index 同样准确，
  // 而且不用把一长串 fileID 塞进 DOM 属性里。
  onPreviewImage(e) {
    const index = Number(e.currentTarget.dataset.index);
    const msg = this.data.messages[index];
    if (!msg || !msg.fileID) return;

    // 预览列表只放图片消息，这样左右滑动看到的是
    // 「这个会话里的所有图片」，而不是滑着滑着冒出一条文字。
    const imageMessages = this.data.messages.filter((m) => m.type === 'image' && m.fileID);
    const fileList = imageMessages.map((m) => m.fileID);
    if (!fileList.length) return;

    wx.showLoading({ title: '加载中', mask: true });

    // 【为什么要先换一次临时链接】
    //   <image> 组件认 cloud:// 开头的 fileID，但 previewImage 不认 ——
    //   它要的是能直接下载的 http 链接。直接把 fileID 传进去，
    //   表现是「点了没反应」，不报错、不提示，最难查的一类问题。
    wx.cloud
      .getTempFileURL({ fileList })
      .then((res) => {
        const ok = (res.fileList || []).filter((f) => f.status === 0 && f.tempFileURL);
        if (!ok.length) {
          wx.showToast({ title: '图片加载失败', icon: 'none' });
          return;
        }

        const urls = ok.map((f) => f.tempFileURL);
        // 定位到用户点的那一张。不定位的话预览会从第一张开始 ——
        // 点的是第三张却看到第一张，得自己往右滑两下。
        const at = ok.findIndex((f) => f.fileID === msg.fileID);
        wx.previewImage({ urls, current: urls[at < 0 ? 0 : at] });
      })
      .catch((err) => {
        console.error('预览图片失败：', err);
        wx.showToast({ title: '图片加载失败', icon: 'none' });
      })
      .then(() => wx.hideLoading());
  },

  // 点顶部商品卡片，跳回详情页
  onOpenGoods() {
    if (!this.data.goodsId) return;
    wx.navigateTo({ url: '/pages/detail/detail?id=' + this.data.goodsId });
  }
});
