// pages/edit/edit.js
const { CLOUD_PATH, DEFAULT_AVATAR, NICKNAME_MAX } = require('../../utils/cloud-config');
const { CAMPUS_OPTIONS } = require('../../utils/campus');

Page({

  /**
   * 页面的初始数据
   */
  data: {
    // 用户信息（初始为空，由 loadProfile 回填）
    // avatar 全程保持空字符串 = 没设头像，由 WXML 兜底显示默认图。
    // 【绝不能】在这里填默认图 —— onSave 会把它交给 uploadAvatar，
    // 而 uploadAvatar 认不出「这是默认图」，会当成用户选的图片上传到云存储。
    // 详见 utils/cloud-config.js 里 DEFAULT_AVATAR 的说明
    userInfo: {
      avatar: '',
      nickname: '',
      realName: '',
      studentId: '',
      campus: '',
      phone: '',
      wechat: ''
    },
    // 校内身份核验状态。来自 getProfile 返回的 user.verified。
    //
    // 【这一页只【显示】它，不提供核验入口】
    //   定位核验只在注册页做一次，云函数里也只有 registerStudent
    //   会写 verified。故意不在这里给一个「重新核验位置」的按钮 ——
    //   那等于开了一条「不填学号、站在学校门口调一次就能拿到通行证」
    //   的旁路，「学号 + 校内定位」这道门槛就少了一半。
    //   未核验的人在这里得到的是一条去注册页的路（onGoRegister）。
    //
    // 【初值是 null（还不知道），不是 false】
    //   档案拉回来之前不知道用户核验过没有。填 false 的话，
    //   已核验的人每次进这一页都会先看到一瞬间的「未核验」+ 去核验按钮，
    //   那一瞬间足够让人以为自己的注册掉了。
    //   WXML 里整块用 verified !== null 挡住，null 时什么都不显示。
    verified: null,
    // 默认头像。WXML 里读不到 require 进来的常量，只能挂到 data 上再引用
    defaultAvatar: DEFAULT_AVATAR,
    showCampusPicker: false,
    // 宿舍（园区）选项。{ text, value } 的形式由 utils/campus.js 生成
    // （Vant 1.10+ 的 picker 只认对象数组）。换学校改那一处。
    campusOptions: CAMPUS_OPTIONS,
    // 提交中标记（防重复提交）
    submitting: false,
    // 键盘高度（px）。撑在页面最底下当滚动余量用，
    // 键盘收起时归 0 —— 详见 onKeyboardHeightChange
    kbHeight: 0
  },

  // 加载当前档案回填表单
  loadProfile() {
    wx.showLoading({ title: '加载中...' });
    return wx.cloud
      .callFunction({ name: 'user', data: { action: 'getProfile' } })
      .then((res) => {
        wx.hideLoading();
        const result = (res && res.result) || {};
        if (result.code !== 0) {
          wx.showToast({ title: result.message || '加载失败', icon: 'none' });
          return;
        }
        // 云函数版本探针。这一页是「真实姓名有没有存进去 / 能不能读回来」的
        // 第一现场：字段空着时，这两行的区别就是「去查数据库」和「去重新部署」。
        // 【看不到 v】本身就是结论 —— 云端跑的是旧版 user 云函数。
        console.log(
          '档案已加载：云函数版本 v' +
          (result.v === undefined ? '（无，云端可能是旧版）' : result.v)
        );
        const user = result.user || {};

        // 宿舍：老档案里可能存着一个【已经下线】的宿舍名（比如换过宿舍列表之后）。
        // 直接原样回填的话会造出一个死局：表单上明明显示着一个看起来正常的宿舍，
        // 用户什么都没改就点保存，云函数拿白名单一比对直接拒绝
        // （「宿舍不在可选范围内」）—— 而他根本看不出问题在哪，因为
        // 界面上那个值看起来完全正常。
        // 所以不认识的值一律清空：让他重新选一次，好过给他一个存不进去的值。
        const campus = user.campus || '';
        const campusKnown = this.data.campusOptions.some((o) => o.value === campus);

        this.setData({
          verified: user.verified === true,
          userInfo: {
            avatar: user.avatar || '',
            nickname: user.nickname || '',
            realName: user.realName || '',
            studentId: user.studentId || '',
            campus: campusKnown ? campus : '',
            phone: user.phone || '',
            wechat: user.wechat || ''
          }
        });
      })
      .catch((err) => {
        wx.hideLoading();
        console.error('加载用户档案失败：', err);
        wx.showToast({ title: '加载失败，请重试', icon: 'none' });
      });
  },

  // 更换头像：只记录本地临时路径，等点保存时再上传
  // 这样用户选完又反悔退出，云端不会留下垃圾文件
  onChangeAvatar() {
    // chooseImage 已废弃，用 chooseMedia
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        if (!file) return;
        this.setData({ 'userInfo.avatar': file.tempFilePath });
      }
    });
  },

  // 昵称变化
  onNicknameChange(e) {
    this.setData({
      'userInfo.nickname': e.detail
    });
  },

  // 【学号和真实姓名没有 onChange 了】
  //   这里原来有 onStudentIdChange / onRealNameChange 两个回调，
  //   现在这两个字段在这一页只展示、不编辑（见 edit.wxml），
  //   留着回调也永远不会被触发 —— 而且会让人误以为这一页还能改它们。

  // 未核验的人从这里去注册页。
  //
  // 用 navigateTo 而不是 reLaunch：注册页是可以退出的正常页面，
  // 用户填一半想回来接着改资料，按返回就能回来。
  onGoRegister() {
    wx.navigateTo({ url: '/pages/register/register' });
  },

  // 手机号变化
  onPhoneChange(e) {
    this.setData({
      'userInfo.phone': e.detail
    });
  },

  // 微信号变化
  onWechatChange(e) {
    this.setData({
      'userInfo.wechat': e.detail
    });
  },

  // 键盘高度 → 页面最底下那块占位（见 edit.wxml 末尾）
  //
  // 【为什么需要它】
  //   这一页内容刚好一屏，页面【没有可滚动的余量】。而 van-field 的
  //   adjust-position 是靠滚动页面把输入框顶到键盘上方的 —— 没余量可滚，
  //   它就只能干看着键盘把「手机号 / 微信号」盖住，用户输的时候看不见
  //   自己打了什么（2026-10-10 反馈的就是这个）。
  //
  //   撑开一块和键盘等高（约 300 多 px）的空白，页面就有了刚好够用的
  //   滚动余量，输入框能被顶到键盘正上方；键盘收起时高度归 0，
  //   页面上不会多出一片空白。
  //
  // ⚠️ 别改成在 wxss 里写死 padding-bottom：那样键盘收起时页面底部
  //    会永远留一大块空白（这个高度是【随键盘类型变的】—— 数字键盘、
  //    中文输入法带候选栏、英文键盘，三者高度都不一样，写死必然错）。
  onKeyboardHeightChange(e) {
    this.setData({
      kbHeight: (e.detail && e.detail.height) || 0
    });
  },

  // 选择宿舍
  onSelectCampus() {
    this.setData({
      showCampusPicker: true
    });
  },

  // 确认选择宿舍
  // Vant 1.10+ 的 confirm 事件里，e.detail.value 是选中项【对象】{ text, value }
  onConfirmCampus(e) {
    const picked = e.detail.value || {};
    this.setData({
      'userInfo.campus': picked.value || '',
      showCampusPicker: false
    });
  },

  // 关闭宿舍选择器
  onCloseCampusPicker() {
    this.setData({
      showCampusPicker: false
    });
  },

  // 上传头像到云存储，返回 fileID
  uploadAvatar(path) {
    if (!path) return Promise.resolve('');
    // 已经是云端图片或网络图片，直接复用，不重复上传
    if (path.indexOf('cloud://') === 0 || path.indexOf('https://') === 0) {
      return Promise.resolve(path);
    }
    const ext = (path.split('.').pop() || 'png').split('?')[0];
    const cloudPath =
      CLOUD_PATH.AVATAR +
      Date.now() +
      '-' +
      Math.random().toString(36).slice(2, 8) +
      '.' +
      ext;
    return wx.cloud.uploadFile({ cloudPath, filePath: path }).then((res) => res.fileID);
  },

  // 保存修改
  onSave() {
    const { userInfo, submitting } = this.data;
    if (submitting) return; // 防止连点重复提交

    // 前端校验只为体验，真正的防线在云函数里
    const nickname = (userInfo.nickname || '').trim();
    if (!nickname) {
      wx.showToast({ title: '请输入昵称', icon: 'none' });
      return;
    }
    if (nickname.length > NICKNAME_MAX) {
      wx.showToast({ title: '昵称不能超过' + NICKNAME_MAX + '个字', icon: 'none' });
      return;
    }
    // 【这里不再校验真名和学号】
    //   它们注册后锁死：这一页没有它们的输入框，提交时也不带它们
    //   （见 edit.wxml 的说明和 cloudfunctions/user/index.js 的 updateProfile）。
    //   原来这里有一条「真名长度」校验，现在连输入框都没有了，留着
    //   只会让人以为这一页还能改真名。
    const phone = (userInfo.phone || '').trim();
    if (phone && !/^1[3-9]\d{9}$/.test(phone)) {
      wx.showToast({ title: '手机号格式不正确', icon: 'none' });
      return;
    }

    this.setData({ submitting: true });
    wx.showLoading({ title: '保存中...' });

    this.uploadAvatar(userInfo.avatar)
      .then((avatar) =>
        wx.cloud.callFunction({
          name: 'user',
          data: {
            action: 'updateProfile',
            avatar,
            nickname,
            // ⚠️ 【故意不传 realName 和 studentId】
            //    云函数把「传了、但和库里不一样」当作篡改，整次保存都会拒绝。
            //    所以把一个旧值原样带上去看着无害，其实很脆：
            //    只要哪次回填多一个空格（trim 差异），用户连改个昵称
            //    都会被判成「试图修改学号」—— 而且报错完全对不上他刚做的事。
            //    不传才是对的：不传 = 不改。
            campus: userInfo.campus || '',
            phone,
            wechat: (userInfo.wechat || '').trim()
          }
        })
      )
      .then((res) => {
        wx.hideLoading();
        this.setData({ submitting: false });
        const result = (res && res.result) || {};
        if (result.code !== 0) {
          wx.showModal({
            title: '提示',
            content: result.message || '保存失败，请重试',
            showCancel: false
          });
          return;
        }
        // 商品快照同步失败时要说出来，不能假装一切正常：
        // 档案已经存好了，但已发布的商品还挂着旧头像旧昵称
        if (result.syncError) {
          wx.showModal({
            title: '资料已保存',
            content:
              '但商品信息同步失败：' + result.syncError +
              '\n云函数版本 v' + (result.v || 0),
            showCancel: false
          });
          this.setData({ submitting: false });
          return;
        }

        // 回写全局档案，让别的页面立刻看到新昵称、新头像。
        //
        // 【用合并，不用整体替换】
        //   updateProfile 返回的 user 是 Object.assign({}, existing,
        //   check.data, ...) —— 【带着 verified】。今天整体替换也不会出事，
        //   但哪天有人把它改成只回几个字段，用户一保存资料就会丢掉
        //   通行证、突然被判成未注册，而且现象是「点保存就要求我重新注册」，
        //   没人会联想到是这里干的。合并对两种返回体都安全。
        const app = getApp();
        if (app && app.globalData) {
          app.globalData.userInfo = Object.assign(
            {},
            app.globalData.userInfo,
            result.user || {}
          );
        }

        // 云函数版本号（result.v）仍在返回值里，排查问题时
        // 可以在调试器 Console 里看到，界面上不再显示
        console.log('保存成功，云函数版本 v' + (result.v || 0) + '，同步商品 ' + (result.synced || 0) + ' 件');
        wx.showToast({ title: '保存成功', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 800);
      })
      .catch((err) => {
        wx.hideLoading();
        this.setData({ submitting: false });
        console.error('保存失败：', err);
        wx.showModal({
          title: '提示',
          content: '网络异常或云函数调用失败，请确认已部署 user 云函数后重试',
          showCancel: false
        });
      });
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad(options) {
    this.loadProfile();
  },

  /**
   * 生命周期函数--监听页面初次渲染完成
   */
  onReady() {

  },

  /**
   * 生命周期函数--监听页面显示
   */
  onShow() {

  },

  /**
   * 生命周期函数--监听页面隐藏
   */
  onHide() {

  },

  /**
   * 生命周期函数--监听页面卸载
   */
  onUnload() {

  },

  /**
   * 页面相关事件处理函数--监听用户下拉动作
   */
  onPullDownRefresh() {

  },

  /**
   * 页面上拉触底事件的处理函数
   */
  onReachBottom() {

  },

  /**
   * 用户点击右上角分享
   */
  onShareAppMessage() {

  }
})
