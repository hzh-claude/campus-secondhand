Component({
  data: {
    active: 0,
    // 未读消息数。0 = 不显示徽标
    unread: 0,
    // 徽标上真正显示的文字，由 setUnread 算好。
    // 【不在 WXML 里现算】是因为 >99 要显示 "99+"，
    // 这种带判断的字符串拼接写在模板里会变成一坨读不懂的三元表达式
    unreadText: '',
    list: [
      {
        pagePath: '/pages/home/home',
        text: '首页',
        icon: 'home-o'
      },
      {
        pagePath: '/pages/push/push',
        text: '发布',
        icon: 'add-o'
      },
      {
        pagePath: '/pages/user/user',
        text: '我的',
        icon: 'user-o'
      }
    ]
  },

  methods: {
    onChange(event) {
      const index = event.detail;
      const url = this.data.list[index].pagePath;
      wx.switchTab({ url });
    },

    init() {
      const page = getCurrentPages().pop();
      const route = page ? page.route : '';
      const active = this.data.list.findIndex(item => item.pagePath.includes(route));
      this.setData({ active: active !== -1 ? active : 0 });
    },

    // 由页面调用（见 utils/unread.js），把未读数喂进来。
    //
    // 【为什么是从外面喂，而不是组件自己查】
    // 组件自己去调云函数，等于让它偷偷依赖一个具体的数据来源 ——
    // 以后想换（比如改成用 watch 推、或者从全局状态读），
    // 就得进组件内部翻。查询归页面，组件只负责显示，
    // 和「前端管显示、后端管裁决」是同一个分工思路。
    setUnread(n) {
      const num = Number(n) || 0;
      this.setData({
        unread: num,
        // 超过 99 显示 99+：徽标那点宽度，四位数会把 tabBar 撑变形
        unreadText: num > 99 ? '99+' : String(num)
      });
    }
  }
});
