// utils/subscribe.js
// 请求订阅消息：用户点一次按钮，就攒一条通知额度。
//
// 两个页面要用它（我卖出的 / 我买到的），逻辑只差一个模板 ID，
// 所以收在这里。以后加第三种通知也只改这一处。
//
// ============================================================
// 两条绕不过去的微信限制
// ============================================================
//
// 【一、必须由用户点击触发，不能自动弹】
//   微信硬性规定 requestSubscribeMessage 必须在【用户点击】的上下文里调用。
//   在 onLoad / onShow 里偷偷调用，微信会直接拒绝 —— 而且连弹窗都不会出现，
//   你只会在控制台看到一句 errCode 20004，很容易误判成自己代码写错了。
//   这条规定防的就是「小程序一进来就弹窗要权限」的骚扰行为，绕不过去。
//
// 【二、一次授权只能发一条】
//   微信只开放「一次性订阅」（长期订阅仅限特定行业）。
//   点一次 = 攒一条额度；成功发一条 = 消耗一条。
//
//   ⚠️ 2026-10-14：界面上【不再写「可接收 1 条」这句提示】了
//   （产品要求：不要拿「微信限制」这种话术打扰用户）。
//   但这【不改变事实】，只是不说了而已 —— 一次授权仍然只能收 1 条。
//   所以这里的 toast 只说到「已开启」为止，【不要】升级成
//   「有新消息会通知你」这类承诺：那是句兑现不了的话，
//   用户收到 1 条之后就再也没有了，而他会一直等。
//
// 返回结果长这样：
//   { errMsg: 'requestSubscribeMessage:ok', '<模板ID>': 'accept' }
//   结果挂在【以模板 ID 为键】的字段上，所以要拿 ID 去取，不能直接读 res.accept。
//
//   三种取值：
//     accept  用户同意了
//     reject  用户在弹窗上点了「拒绝」
//     ban     用户【在微信设置里】把本小程序的这类消息整体关掉了 ——
//             这种情况下弹窗根本不会出现，永远只会返回 ban，
//             所以必须单独提示他「去哪儿打开」，光说「你拒绝了」没有用。

// ============================================================
// 「已经开过一次」记在哪
// ============================================================
//
// 页面上的引导横条（「有人下单时通知我」+ 开启按钮）现在只在
// 【还没开过】的时候显示，开过一次就收起来 —— 别天天杵在那儿。
// 所以需要一个「开过没有」的标记，存在本地。
//
// 【为什么不用服务端】这个标记只决定「横条显不显示」，是纯展示层的事。
//   存本地就够，还省一次网络请求。代价是换手机 / 重新装小程序之后
//   横条会再出现一次 —— 对一个引导条来说这个代价可以接受。
//
// 【⚠️ 它记的到底是什么】
//   记的【不是】「通知已永久开启」—— 那件事在微信侧不存在（见上面第二条）。
//   记的只是「这个引导横条已经完成任务了，别再显示」。
//   真正的续期入口在「设置」页，那里【永远】都在 ——
//   因为额度迟早会用完，而那时用户必须还能找到地方再开一次。
const DONE_PREFIX = 'subscribeDone:';

function markDone(templateId) {
  try {
    wx.setStorageSync(DONE_PREFIX + templateId, Date.now());
  } catch (e) {
    // 存储写失败【不打断本次订阅】：这次授权是成功的，
    // 只是下次进来横条还会出现而已。为了一个「记不记」的问题
    // 把用户刚点成功的动作报成失败，是本末倒置。
    console.warn('记录订阅状态失败：', e);
  }
}

function isDone(templateId) {
  try {
    return !!wx.getStorageSync(DONE_PREFIX + templateId);
  } catch (e) {
    // 读不出来就当「没开过」：横条多显示一次，
    // 总好过该显示的时候不显示，用户永远找不到入口
    return false;
  }
}

// onDone：订阅【成功】之后回调，让页面把横条收起来。
//   不传也不会出错 —— 「设置」页那边就不需要（它没有横条，
//   那两个入口要一直摆着当续期通道）。
function requestSubscribe(templateId, subject, onDone) {
  if (!templateId) {
    console.error('requestSubscribe: 缺少模板 ID');
    return;
  }

  wx.requestSubscribeMessage({
    tmplIds: [templateId],
    success: (res) => {
      const result = res[templateId];

      if (result === 'accept') {
        markDone(templateId);
        wx.showToast({ title: '已开启' + subject, icon: 'success' });
        if (typeof onDone === 'function') onDone();
      } else if (result === 'reject') {
        wx.showToast({ title: '已取消，可再点一次开启', icon: 'none' });
      } else if (result === 'ban') {
        wx.showModal({
          title: '通知权限被关闭',
          content: '你之前在微信里关闭过本小程序的通知。请打开本小程序，点右上角「…」→ 设置，重新打开订阅消息。',
          showCancel: false
        });
      }
    },
    fail: (err) => {
      console.error('请求订阅失败：', err);
      wx.showToast({ title: '开启失败，请重试', icon: 'none' });
    }
  });
}

module.exports = { requestSubscribe, isDone };
