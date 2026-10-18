// pages/suggest/suggest.js
//
// 意见反馈。
//
// 【这个页面曾经是个空壳，而且它是【故意】空的】
//   以前的 onSubmit 只弹一句「意见反馈功能开发中」，顶部还挂了一条
//   notice-banner 老实告诉用户功能没开放。当时刻意【没有】假装提交成功：
//   用户认真打一段字、选类型、传截图、留联系方式，界面点头说「提交成功」，
//   然后四个字段一个都没被读走 —— 那不是功能缺失，是功能撒谎。
//   功能缺失，用户觉得「这软件还不全」；功能撒谎，用户觉得「这软件骗我」，
//   而且它不报错，你永远不会知道有多少人白写了。
//
// 【现在它是真的了】文字 + 最多 3 张截图 + 选填联系方式，走 feedback 云函数。
//
// 【为什么云函数叫 feedback 而不是 submitFeedback】
//   当初那段注释里写的是「加一个 submitFeedback 云函数」。现在改了名字，
//   因为它从第一天起就有【两个】动作：提交、看我的。项目惯例是一个域
//   一个云函数 + event.action 分发（address / notice / chat 都是这么写的）。
//   叫 submitFeedback 的话，「我的反馈」就得再开一个云函数，或者塞进
//   别人家里 —— 那正是这个惯例要避免的碎片化。
const {
  CLOUD_PATH,
  FEEDBACK_TYPE,
  FEEDBACK_TYPE_TEXT,
  FEEDBACK_IMAGE_MAX,
  FEEDBACK_CONTENT_MAX
} = require('../../utils/cloud-config');

// 单张图上传前的体积上限。
// 服务端硬卡 1M（imgSecCheck 的限制），这里留点余量 ——
// 卡在 1M 的话，压缩后正好 1.01M 的图会在服务端被拒，
// 而用户已经在等了。900K 能让绝大多数截图一次过。
const IMG_UPLOAD_MAX = 900 * 1024;

// 允许上传的后缀。不在里面的（尤其是 wx.chooseMedia 在某些机型上
// 会给出的 .heic）一律按 jpg 命名 —— 服务端只认 png/jpg/jpeg/gif/bmp，
// 名字不对会在那边被当成「格式不支持」拒掉，而用户看到的是一张
// 完全正常的图，无从下手。
const IMG_EXT_OK = ['png', 'jpg', 'jpeg', 'gif', 'bmp'];

// 拿不到 openid 时抛这个。单独定一个常量是为了在 catch 里能认出来，
// 给一句和「网络异常」完全不同的话 —— 这两种情况的处理方式不一样，
// 混成一句会让人对着一个其实没问题的网络查半天。
const ERR_NO_OPENID = 'NO_OPENID';

// 反馈类型选项。
// 【这里不再自己写一份了】——以前是页面上手写的四个 { label, value }，
// 现在从 utils/cloud-config.js 的常量拼出来。那个文件里的值和云函数
// 用的是同一份（云函数 require 不到 utils，各写一份，搜索 FEEDBACK_TYPE
// 能同时找到这两个地方）。这里再抄一遍的话，加一个类型就会出现
// 「界面上选得到、服务端不认」。
const TYPE_OPTIONS = [
  { label: FEEDBACK_TYPE_TEXT[FEEDBACK_TYPE.FEATURE], value: FEEDBACK_TYPE.FEATURE },
  { label: FEEDBACK_TYPE_TEXT[FEEDBACK_TYPE.BUG], value: FEEDBACK_TYPE.BUG },
  { label: FEEDBACK_TYPE_TEXT[FEEDBACK_TYPE.TRADE], value: FEEDBACK_TYPE.TRADE },
  { label: FEEDBACK_TYPE_TEXT[FEEDBACK_TYPE.OTHER], value: FEEDBACK_TYPE.OTHER }
];

Page({
  data: {
    typeOptions: TYPE_OPTIONS,
    feedbackType: FEEDBACK_TYPE.FEATURE,
    content: '',
    contact: '',

    // [{ path, size }]，path 是【手机上的本地临时路径】，此时还没上传。
    // 上传发生在点提交的那一刻，理由见 onSubmit 上面那段。
    // （size 目前没有地方读它 —— 它是 prepareImage 里那次体积检查的产物。
    //   留着是为了排查「这张图到底多大」时有得看，不是给界面用的。）
    imageList: [],

    // 张数上限和字数上限也放进 data，这样 WXML 能直接读 {{imageMax}} /
    // {{contentMax}}，不用把 3 和 500 再硬抄一遍到模板里。
    // （WXML 里写不了 require，只能读 data —— 硬写的话这两个数字
    //   会从「三处」变成「四处」，而且 WXML 那处 grep 不到。）
    imageMax: FEEDBACK_IMAGE_MAX,
    contentMax: FEEDBACK_CONTENT_MAX,

    submitting: false
  },

  // 选择反馈类型
  onSelectType(e) {
    const { value } = e.currentTarget.dataset;
    this.setData({ feedbackType: value });
  },

  // 内容输入
  onContentInput(e) {
    this.setData({ content: e.detail.value });
  },

  // 联系方式输入
  onContactInput(e) {
    this.setData({ contact: e.detail.value });
  },

  // 添加图片
  //
  // 【为什么用 wx.chooseMedia 而不是 wx.chooseImage】
  //   后者是废弃接口。更实际的原因是它返回的 res.tempFilePaths 只有路径，
  //   没有体积 —— 而体积正是这里最需要的一个数（见 prepareImage）。
  onAddImage() {
    const remain = this.data.imageMax - this.data.imageList.length;
    if (remain <= 0) return;

    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const files = (res.tempFiles || []).filter((f) => f && f.tempFilePath);
        if (!files.length) return;

        // 逐张压缩 + 查体积，全部处理完再一次性 setData ——
        // 每张都 setData 一次会让列表闪好几下
        Promise.all(files.map((f) => this.prepareImage(f.tempFilePath))).then((list) => {
          const ok = list.filter(Boolean);
          if (!ok.length) return;
          this.setData({ imageList: this.data.imageList.concat(ok) });
        });
      },
      // 用户点「取消」也会走 fail，那是正常操作，不该弹错误提示。
      // 留个空函数是【故意的】，不是忘了写。
      fail: () => {}
    });
  },

  // 压缩 + 查体积。成功返回 { path, size }，不合格返回 null（并已经提示过了）
  prepareImage(src) {
    return new Promise((resolve) => {
      wx.compressImage({
        src,
        quality: 60,
        success: (r) => resolve(r.tempFilePath || src),
        // compressImage 对某些格式（部分 png）会失败。失败不是错误，
        // 退回原图让下面的体积检查去决定
        fail: () => resolve(src)
      });
    }).then(
      (path) =>
        new Promise((resolve) => {
          wx.getFileSystemManager().getFileInfo({
            filePath: path,
            success: (info) => {
              if (info.size > IMG_UPLOAD_MAX) {
                wx.showToast({ title: '有图片太大，没有添加进来', icon: 'none' });
                resolve(null);
                return;
              }
              resolve({ path, size: info.size });
            },
            // 读不到体积就放行，交给服务端去拦 ——
            // 那边的图片检测是 fail-closed 的，不会放一张没检过的图进来。
            // 这里宁可不拦，也不要因为一个环境问题就把正常的图挡在外面。
            fail: () => resolve({ path, size: 0 })
          });
        })
    );
  },

  // 删除图片。
  //
  // 这里只删本地数组里的一项，【不碰云存储】—— 因为这时候图还没上传。
  // 这正是「提交时才上传」这个选择换来的好处：用户在选图阶段怎么反复加加减减，
  // 云存储里都不会留下任何东西，也就没有孤儿文件要清理。
  onDeleteImage(e) {
    const { index } = e.currentTarget.dataset;
    const imageList = this.data.imageList.filter((_, i) => i !== index);
    this.setData({ imageList });
  },

  // 预览。此时是本地路径，wx.previewImage 直接认，不用转。
  // （「我的反馈」列表那边就不一样了，那边是 cloud:// fileID，
  //   previewImage 不认，得先 getTempFileURL。）
  onPreviewImage(e) {
    const { index } = e.currentTarget.dataset;
    const urls = this.data.imageList.map((i) => i.path);
    if (!urls.length) return;
    wx.previewImage({ current: urls[index], urls });
  },

  onOpenMyFeedback() {
    wx.navigateTo({ url: '/pages/my_feedback/my_feedback' });
  },

  // ============================================================
  // 提交
  // ============================================================
  //
  // 【图片为什么在提交时才上传，而不是选完就传】
  //   chat 页是「选完立刻上传」，这里故意不一样。
  //   反馈是【批量提交】：用户会一次选三张，然后删掉一张、再补一张。
  //   选图即传的话，删掉的那张已经躺在云存储里了，而且永远不会被任何
  //   记录引用 —— 这类孤儿没有任何地方会发现它们，只会一直占着存储。
  //   推迟到提交那一刻统一上传，就从源头消掉了这一整类问题。
  //   压缩和体积检查仍然在选图时做（那是体验），只是不上传。
  //
  // 【上传顺序】逐张串行，不用 Promise.all。
  //   最多 3 张，性能上无所谓；串行的好处是中途失败时，
  //   「已经传上去的是哪几张」是确定的，清理起来不会漏也不会多删。
  // ============================================================
  onSubmit() {
    if (this.data.submitting) return;

    const { feedbackType, content, contact, imageList } = this.data;
    const text = (content || '').trim();

    // 客户端校验【只管体验】—— 真正把关的是云函数。
    // 这里拦一下只是省掉一次白跑的往返。
    if (!text) {
      wx.showToast({ title: '请填写问题描述', icon: 'none' });
      return;
    }
    if (text.length > this.data.contentMax) {
      wx.showToast({ title: '描述太长了', icon: 'none' });
      return;
    }

    this.setData({ submitting: true });
    wx.showLoading({ title: '提交中...', mask: true });

    this.ensureOpenid()
      .then((openid) => this.uploadAll(imageList, openid))
      .then((fileIDs) =>
        wx.cloud.callFunction({
          name: 'feedback',
          data: {
            action: 'submit',
            type: feedbackType,
            content: text,
            contact: (contact || '').trim(),
            images: fileIDs
          }
        })
      )
      .then((res) => {
        wx.hideLoading();
        this.setData({ submitting: false });

        const result = (res && res.result) || {};
        if (result.code !== 0) {
          // 原样透传服务端的说法，不吞成「提交失败」：
          // 那句话里写着到底是文本违规、图片违规还是频率超限，
          // 而「提交失败」什么都没说，用户只能反复重试同一件错事。
          //
          // ⚠️ 这里【不删图】：服务端在返回失败之前已经把它收到的图
          //    全部删掉了（见云函数里每条失败路径后面的 deleteOwnImages）。
          //    客户端再删一次是重复动作，而且删的可能是别人的图。
          wx.showModal({
            title: '提交未通过',
            content: result.message || '提交失败，请重试',
            showCancel: false
          });
          return;
        }

        this.resetForm();

        // 用 modal 而不是 toast：这里除了告诉用户「成了」，
        // 还要给一个「去哪看」的出口 —— toast 放不下第二个动作。
        wx.showModal({
          title: '提交成功',
          content: '我们已经收到了。处理进度可以在「我的反馈」里查看。',
          confirmText: '去看看',
          cancelText: '知道了',
          success: (m) => {
            if (m.confirm) this.onOpenMyFeedback();
          }
        });
      })
      .catch((err) => {
        wx.hideLoading();
        // ⚠️ 错误路径上【也要复位】。漏了的话按钮此后永远点不动，
        //    而用户看到的只是「点了没反应」，很难联想到是这里。
        this.setData({ submitting: false });

        if (err && err.message === ERR_NO_OPENID) {
          wx.showModal({
            title: '提示',
            content: '登录状态还没就绪，请退出小程序重进一次再试',
            showCancel: false
          });
          return;
        }

        console.error('提交反馈失败：', err);
        wx.showModal({
          title: '提示',
          content: '网络异常，请稍后重试',
          showCancel: false
        });
      });
  },

  // 拿到自己的 openid。
  //
  // 【为什么不能直接读 getApp().globalData.openid】
  //   它的初始值是空字符串，只有 login 云函数回来了才会被填上
  //   （见 app.js 的 login）。进这个页面时它【不一定】就绪。
  //   直接读的话，上传路径会拼成 feedback//xxx.png —— 服务端拿
  //   getWXContext 的 openid 去比，对不上，报「只能提交本次上传的截图」，
  //   而用户和你看半天都看不出是路径本身畸形。
  //
  //   app.login() 自带并发去重（内部的 loginPromise），重复调用只发一次
  //   请求，所以这里放心再要一次。
  ensureOpenid() {
    const app = getApp();
    return app.login().then((result) => {
      const openid =
        (result && result.openid) || (app.globalData && app.globalData.openid) || '';
      if (!openid) {
        throw new Error(ERR_NO_OPENID);
      }
      return openid;
    });
  },

  // 逐张串行上传，返回 fileID 数组。
  // 中途失败会把【已经传上去的】清掉再抛出去 —— 不留孤儿。
  uploadAll(imageList, openid) {
    const uploaded = [];
    let chain = Promise.resolve();

    (imageList || []).forEach((item) => {
      chain = chain.then(() =>
        wx.cloud
          .uploadFile({
            cloudPath: this.buildCloudPath(item.path, openid),
            filePath: item.path
          })
          .then((res) => {
            uploaded.push(res.fileID);
          })
      );
    });

    return chain.then(() => uploaded).catch((err) => {
      this.deleteUploaded(uploaded);
      throw err;
    });
  },

  // 拼云存储路径：feedback/<openid>/<时间戳-随机数>.<后缀>
  //
  // 中间那一层 openid 是【安全边界】，不是整理用的：
  // 服务端要靠它独立判断「这张图是不是调用者自己的」，才敢在检测不通过时
  // 删掉它。只判 feedback/ 前缀的话，别人拿到你的 fileID 就能让服务端
  // 删掉你的图 —— 删除不可逆。详细推演见云函数的 validFeedbackImage。
  //
  // ⚠️【这跟 chat 的写法看起来是矛盾的，其实不是】
  //   pages/chat/chat.js 里有一条注释写着「把 openid 写进文件名等于
  //   到处留身份标识」，所以聊天图用的是 chat/<conversationId>/。
  //   两边判断不同，是因为【fileID 会流到哪里】不同：
  //     chat 的 fileID 会随消息发给对方 —— 对方能看到这一串，
  //       写 openid 就等于把你的身份标识塞进了别人手机里。
  //     feedback 的 fileID 只存在于【你自己】的记录和【管理员】的
  //       控制台里，从不发给任何其他用户（见 my_feedback 页：只有
  //       提交者本人能看到自己的反馈）。
  //   没有外流，就没有 chat 要防的那个问题；而这边又没有 conversationId
  //   可用，openid 是唯一服务端能独立验证的边界。两边的选择是按各自的
  //   数据流向做的，不是随便定的。
  buildCloudPath(filePath, openid) {
    let ext = (filePath.split('.').pop() || '').toLowerCase().split('?')[0];
    if (IMG_EXT_OK.indexOf(ext) < 0) ext = 'jpg';
    const name =
      Date.now() + '-' + Math.floor(Math.random() * 1000000) + '.' + ext;
    return CLOUD_PATH.FEEDBACK_IMAGE + openid + '/' + name;
  },

  // 清掉刚上传、但这次提交没用上的图。
  //
  // 【绝不能 throw】它总是出现在失败分支里。自己再抛一次的话，
  // 真正的原因（上传失败 / 网络异常）会被第二个错误盖掉，
  // 用户看到一句莫名其妙的话。删不掉只是该记日志的事。
  deleteUploaded(fileIDs) {
    const list = (fileIDs || []).filter(Boolean);
    if (!list.length) return;
    wx.cloud.deleteFile({ fileList: list }).catch((err) => {
      console.warn('清理未使用的反馈截图失败：', err);
    });
  },

  resetForm() {
    this.setData({
      feedbackType: FEEDBACK_TYPE.FEATURE,
      content: '',
      contact: '',
      imageList: []
    });
  },

  onLoad(options) {},
  onReady() {},
  onShow() {},
  onHide() {},
  onUnload() {},
  onPullDownRefresh() {},
  onReachBottom() {},
  onShareAppMessage() {}
});
