// pages/my_feedback/my_feedback.js
// 我的反馈：我提交过的意见反馈，以及它们现在的处理状态
//
// 【为什么单独开一个页面，而不是塞进「我的」工具箱】
//   pages/settings/settings.js 里有一句写下来的项目取向：已经有入口的东西
//   不再抄一份。反馈的提交入口在「我的 → 意见反馈」，「看历史」依附于
//   同一件事 —— 用户的心智是「我刚反馈了，去哪看」。塞进工具箱会多出
//   一组重复入口，而且和「意见反馈」挤在同一栏，点之前分不清。
//   所以这个页面的入口在 suggest 页里（提交按钮上方那一行）。
//
// 【这个页面只读】
//   没有撤回、没有编辑、没有删除。状态是管理员在云开发控制台改的
//   （见 cloudfunctions/feedback/index.js 顶部的操作说明）。
//   这里一件事都不做，只负责把服务端给的东西如实显示出来。
const {
  FEEDBACK_TYPE_TEXT,
  FEEDBACK_STATUS,
  FEEDBACK_STATUS_TEXT
} = require('../../utils/cloud-config');
const { formatTime } = require('../../utils/util');

Page({
  data: {
    list: [],
    loading: false,
    emptyText: '还没有提交过反馈'
  },

  loadList() {
    this.setData({ loading: true });
    return wx.cloud
      .callFunction({ name: 'feedback', data: { action: 'listMine' } })
      .then((res) => {
        this.setData({ loading: false });
        const result = (res && res.result) || {};
        if (result.code !== 0) {
          wx.showToast({ title: result.message || '加载失败', icon: 'none' });
          return;
        }

        const list = (result.list || []).map((f) => {
          // ⚠️【只认精确的 'done'】，其余一切值都算「处理中」。
          //
          //    状态是管理员在云开发控制台手改的，一定会有人打成 'Done' /
          //    '已处理' / 'resolved'，或者前后带个空格。
          //    如果反过来写「不是 pending 就算已处理」，那么任何一个打错的
          //    字都会让【没处理】的反馈在用户眼里变成【已处理】—— 用户以为
          //    有人管了，于是不再追问，这条反馈就真死了。那是这个功能从
          //    第一天起就在避免的「界面撒谎」。
          //    按现在这么写，打错字最坏的结果是「处理了但显示处理中」：
          //    用户多等，但不会误以为已经有人回应过他。宁保守，不撒谎。
          //
          //    这个判断【只有这一处】—— 云函数的 listMine 原样透传 status，
          //    刻意不判，就是为了不让同一条规则存两份。
          const done = f.status === FEEDBACK_STATUS.DONE;
          return {
            id: f.id,
            // 类型值理论上受服务端白名单约束，但库里的老记录（或者以后
            // 加了新类型而这份前端还没更新）可能是这里没有的值。
            // 兜底成「其他问题」，总比在标签上显示一个生英文单词强。
            typeText: FEEDBACK_TYPE_TEXT[f.type] || FEEDBACK_TYPE_TEXT.other,
            done,
            statusText: done
              ? FEEDBACK_STATUS_TEXT[FEEDBACK_STATUS.DONE]
              : FEEDBACK_STATUS_TEXT[FEEDBACK_STATUS.PENDING],
            content: f.content,
            images: f.images || [],
            time: formatTime(f.createTime),
            // reply 是管理员在控制台手填的。非空才显示那一块 ——
            // 空字符串会让用户看到一块空白框，以为没写完。
            reply: (f.reply || '').trim()
          };
        });

        this.setData({ list });
      })
      .catch((err) => {
        this.setData({ loading: false });
        console.error('加载反馈列表失败：', err);
        wx.showToast({ title: '加载失败，请下拉重试', icon: 'none' });
      });
  },

  // 预览截图。
  //
  // 【为什么要先换临时链接】
  //   库里的 images 存的是 cloud:// 开头的 fileID。
  //   <image> 组件认这个格式，但 wx.previewImage 不认 —— 它要的是能直接
  //   下载的 http 链接。直接把 fileID 传进去的表现是「点了没反应」：
  //   不报错、不提示、不跳转，看起来像页面卡了。chat 页踩过同一个坑。
  onPreviewImage(e) {
    const { id, index } = e.currentTarget.dataset;
    const item = this.data.list.find((f) => f.id === id);
    const fileList = (item && item.images) || [];
    if (!fileList.length) return;

    wx.showLoading({ title: '加载中', mask: true });

    wx.cloud
      .getTempFileURL({ fileList })
      .then((res) => {
        wx.hideLoading();
        // status 为 0 才是成功。失败的那些（文件被删了、权限变了）
        // 直接剔掉，不往 previewImage 里塞空字符串 —— 那会让预览
        // 列表里出现一张打不开的黑图。
        const ok = (res.fileList || []).filter((f) => f.status === 0 && f.tempFileURL);
        if (!ok.length) {
          wx.showToast({ title: '图片加载失败', icon: 'none' });
          return;
        }

        const urls = ok.map((f) => f.tempFileURL);
        // 【按 fileID 找，不能按 index 找】
        //   ok 是过滤过的，下标和 item.images 已经对不上了。
        //   上面剔掉任意一张，往后所有的下标就整体错位 ——
        //   点的是第三张，会预览到原本的第四张。
        const current = fileList[index];
        const at = ok.findIndex((f) => f.fileID === current);
        wx.previewImage({ urls, current: urls[at < 0 ? 0 : at] });
      })
      .catch((err) => {
        wx.hideLoading();
        console.error('获取反馈截图临时链接失败：', err);
        wx.showToast({ title: '图片加载失败', icon: 'none' });
      });
  },

  // 放在 onShow 而不是 onLoad：管理员改完状态后，用户可能只是切出去
  // 再切回来。onLoad 只跑一次，那样状态永远停在他进页面那一刻的样子，
  // 而「去控制台改状态 → 回来看到变了」正是这个功能的验收方式。
  // 「我买到的」页面出于同样的理由把加载放在 onShow。
  onShow() {
    this.loadList();
  },

  onPullDownRefresh() {
    this.loadList().then(() => wx.stopPullDownRefresh());
  },

  onShareAppMessage() {}
});
