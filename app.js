// app.js
const { ENV_ID } = require('./utils/cloud-config');

App({
  onLaunch() {
    // 云开发能力检测
    if (!wx.cloud) {
      console.error('当前基础库版本过低，请将基础库升级至 2.2.3 及以上以使用云开发能力');
      return;
    }

    // 初始化云开发环境（ENV_ID 在 utils/cloud-config.js 中统一维护）
    wx.cloud.init({
      env: ENV_ID,
      traceUser: true
    });

    // 静默登录：换取 openid 并初始化用户档案
    //
    // 【这里【不再】检查注册闸门了，而且是有意的】
    //
    // 原来 onLaunch 里不核验就 wx.reLaunch 到注册页 —— 一堵硬墙。两个问题：
    //
    //   ① 注册页因此【没有出口】。reLaunch 清空了页面栈，原生导航栏就
    //      不会出现返回箭头。用户唯一能走的路是微信自己加的那个
    //      「返回首页」小房子（小程序从非首页进入时微信原生加的，不是
    //      我们的代码 —— 全项目搜不到任何首页图标），点它会 reLaunch
    //      到 app.json pages 的第一项，也就是首页。
    //   ② 而 onLaunch 一辈子只跑一次。小房子这么一绕，闸门就再也
    //      不会被执行 —— 用户从此可以自由浏览，而前端【从来没有】
    //      为「未核验」准备过任何引导。
    //
    // 现在改成软门：浏览开放，拦截落在每个「需要核验的动作」入口上
    // （发布、下单、聊天），由 guardVerified / checkVerified 提供。
    // 真正的裁决一直在云函数里（publishGoods / order / chat 各自
    // 查一遍 users.verified），前端这层只管体验。
    //
    // 【登录失败时什么都不做】这条没变，也仍然重要：拿不到档案就把人
    // 当成未注册，等于一次网络抖动让已注册用户看到「你还没注册」。
    this.login().catch(() => {
      // 网络断了、云函数没部署 —— 让他停在首页，那里会提示加载失败
    });
  },

  // 核验状态：'yes' | 'no' | 'unknown'
  //
  // 【为什么要分三态，不直接返回布尔】
  //   userInfo 在冷启动时是 null，要等 login 回来才被填上。
  //   这时候直接判会把【已注册用户】误判成未注册 —— 他打开小程序
  //   手快点了下单，就会看到一个「请先去注册」的弹框。
  //   拿不准的时候（'unknown'）必须放行，交给服务端裁决：
  //   让已注册用户多看到一次服务端报错，远好过告诉他账号没注册。
  async checkVerified() {
    if (!this.globalData.userInfo) {
      await this.login().catch(() => null);
    }
    const user = this.globalData.userInfo;
    if (!user) return 'unknown'; // 登录失败：不知道，交给服务端
    return user.verified === true ? 'yes' : 'no';
  },

  // 需要核验的动作（下单、联系卖家）的前置守卫。
  //
  // 返回 true = 继续；false = 已经弹框引导过了，调用方直接 return。
  // 调用方式：if (!(await getApp().guardVerified())) return;
  //
  // 【为什么用 navigateTo 而不是 reLaunch 去注册页】
  //   注册页现在是一个正常的、可以退出的页面。用户点「再看看」
  //   就能留在原页继续逛 —— 这正是「未注册可以浏览」的意思。
  guardVerified() {
    return this.checkVerified().then((state) => {
      if (state !== 'no') return true; // 'unknown' 也放行，理由见上

      return new Promise((resolve) => {
        wx.showModal({
          title: '需要先完成注册',
          content: '完成校内身份核验后才能买卖闲置物品。',
          confirmText: '去注册',
          cancelText: '再看看',
          success: (res) => {
            if (res.confirm) {
              wx.navigateTo({ url: '/pages/register/register' });
            }
            resolve(false);
          },
          // 弹窗都调不起来了（极少见），也当「已经拦下」处理，
          // 不能 resolve(true) 把请求放出去
          fail: () => resolve(false)
        });
      });
    });
  },

  // 登录（带并发去重，多处调用只发一次请求）
  login() {
    if (this.globalData.loginPromise) return this.globalData.loginPromise;

    this.globalData.loginPromise = wx.cloud
      .callFunction({ name: 'login' })
      .then((res) => {
        const result = res.result || {};
        if (result.code === 0) {
          this.globalData.openid = result.openid;
          this.globalData.userInfo = result.user || null;
          if (result.isNew) {
            console.log('新用户已创建档案：', result.openid);
          }
        } else {
          console.error('登录失败：', result.message);
        }
        return result;
      })
      .catch((err) => {
        // 失败后允许下次重试
        this.globalData.loginPromise = null;
        console.error('login 云函数调用失败，请确认已部署 login 云函数：', err);
        throw err;
      });

    return this.globalData.loginPromise;
  },

  globalData: {
    userInfo: null,
    openid: '',
    loginPromise: null
  }
});
