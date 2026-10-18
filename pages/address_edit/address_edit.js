// pages/address_edit/address_edit.js
const { CAMPUS_OPTIONS } = require('../../utils/campus');

Page({
  data: {
    isEdit: false,
    addressId: null,
    formData: {
      name: '',
      phone: '',
      campus: '',
      detail: '',
      isDefault: false
    },
    submitting: false,
    // 键盘高度（px）。页面末尾那块占位用，见 onKeyboardHeightChange
    kbHeight: 0,
    showCampusPicker: false,
    // 宿舍（园区）选项。{ text, value } 的形式由 utils/campus.js 生成
    // （Vant 1.10+ 的 picker 只认对象数组）。换学校改那一处。
    campusOptions: CAMPUS_OPTIONS
  },

  onLoad(options) {
    if (options && options.id) {
      this.setData({
        isEdit: true,
        addressId: options.id
      });
      wx.setNavigationBarTitle({ title: '编辑地址' });
      this.loadAddressData(options.id);
    } else {
      wx.setNavigationBarTitle({ title: '新增地址' });
    }
  },

  // 编辑模式：把这条地址从数据库读出来回填表单
  loadAddressData(id) {
    wx.showLoading({ title: '加载中...' });
    wx.cloud
      .callFunction({ name: 'address', data: { action: 'list' } })
      .then((res) => {
        wx.hideLoading();
        const result = (res && res.result) || {};
        if (result.code !== 0) {
          wx.showToast({ title: result.message || '加载失败', icon: 'none' });
          return;
        }
        const item = (result.list || []).filter((a) => a._id === id)[0];
        if (!item) {
          wx.showToast({ title: '地址不存在', icon: 'none' });
          return;
        }
        this.setData({
          formData: {
            name: item.name || '',
            phone: item.phone || '',
            campus: item.campus || '',
            detail: item.detail || '',
            isDefault: !!item.isDefault
          }
        });
      })
      .catch((err) => {
        wx.hideLoading();
        console.error('加载地址失败：', err);
        wx.showToast({ title: '加载失败', icon: 'none' });
      });
  },

  // 联系人变化
  onNameChange(e) {
    this.setData({ 'formData.name': e.detail });
  },

  // 手机号变化
  onPhoneChange(e) {
    this.setData({ 'formData.phone': e.detail });
  },

  // 详细地址变化
  onDetailChange(e) {
    this.setData({ 'formData.detail': e.detail });
  },

  // 键盘高度 → 页面末尾那块占位（见 address_edit.wxml）
  // 和 pages/edit/edit.js 里同名方法是同一个东西：撑出滚动余量，
  // 让 van-field 的 adjust-position 有地方把输入框顶出键盘。
  // 那边写了一段完整说明，改的时候两处一起看。
  onKeyboardHeightChange(e) {
    this.setData({ kbHeight: (e.detail && e.detail.height) || 0 });
  },

  // 选择宿舍
  onSelectCampus() {
    this.setData({ showCampusPicker: true });
  },

  // 确认选择宿舍
  // Vant 1.10+ 的 confirm 事件里，e.detail.value 是选中项【对象】{ text, value }
  onConfirmCampus(e) {
    const picked = e.detail.value || {};
    this.setData({
      'formData.campus': picked.value || '',
      showCampusPicker: false
    });
  },

  // 关闭宿舍选择器
  onCloseCampusPicker() {
    this.setData({ showCampusPicker: false });
  },

  // 设为默认
  onDefaultChange(e) {
    this.setData({ 'formData.isDefault': e.detail });
  },

  // 保存：编辑走 update，新增走 add
  onSave() {
    const { formData, isEdit, addressId, submitting } = this.data;
    if (submitting) return; // 防止连点重复提交

    // 客户端校验：只为体验，真正的把关在服务端
    if (!formData.name) {
      return wx.showToast({ title: '请输入联系人', icon: 'none' });
    }
    if (!/^1[3-9]\d{9}$/.test(formData.phone)) {
      return wx.showToast({ title: '请输入正确的手机号', icon: 'none' });
    }
    if (!formData.campus) {
      return wx.showToast({ title: '请选择宿舍', icon: 'none' });
    }
    if (!formData.detail) {
      return wx.showToast({ title: '请输入详细地址', icon: 'none' });
    }

    const payload = Object.assign({}, formData);
    if (isEdit) {
      payload.action = 'update';
      payload.id = addressId;
    } else {
      payload.action = 'add';
    }

    this.setData({ submitting: true });
    wx.showLoading({ title: '保存中...' });

    wx.cloud
      .callFunction({ name: 'address', data: payload })
      .then((res) => {
        wx.hideLoading();
        this.setData({ submitting: false });
        const result = (res && res.result) || {};
        if (result.code !== 0) {
          // 服务端校验失败（比如手机号格式），把提示原样给用户
          wx.showModal({
            title: '提示',
            content: result.message || '保存失败',
            showCancel: false
          });
          return;
        }
        wx.showToast({ title: '保存成功', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 800);
      })
      .catch((err) => {
        wx.hideLoading();
        this.setData({ submitting: false });
        console.error('保存地址失败：', err);
        wx.showModal({
          title: '提示',
          content: '网络异常，请稍后重试',
          showCancel: false
        });
      });
  },

  onReady() {},
  onShow() {},
  onHide() {},
  onUnload() {},
  onPullDownRefresh() {},
  onReachBottom() {},
  onShareAppMessage() {}
});
