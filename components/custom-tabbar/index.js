Component({
  properties: {
    active: {
      type: Number,
      value: 0
    }
  },

  methods: {
    onChange(event) {
      const index = event.detail;
      const pages = ['/pages/home/home', '/pages/push/push', '/pages/user/user'];
      wx.switchTab({
        url: pages[index]
      });
    }
  }
});
