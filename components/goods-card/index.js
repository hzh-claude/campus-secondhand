// components/goods-card/index.js
// 商品卡片（浏览态）：首页 / 分类页 / 搜索页共用。
//
// 为什么抽这个：这三个页面的卡片 WXML 逐字相同、WXSS 逐字相同，
// 一共 3 份。改一个间距要改 3 个文件，改漏一个就是「首页和分类页
// 的卡片不一样高」——这种差异不会报错，只会让页面看着有点怪。
//
// 【为什么不用 data-id 传商品 ID】
// 是在自定义组件上绑定 data-* 再读 e.currentTarget.dataset 的做法，
// 在 glass-easel（本项目 app.json 里启用）下依赖宿主节点的行为，
// 出问题时是「点了没反应」而不是报错。
// 所以这里改成组件内 triggerEvent 把 id 明确回传出去 ——
// 通道是显式的，页面拿 e.detail.id，不依赖任何隐式行为。
//
// 【为什么不把整个 item 对象当一个 property 传】
// 传对象写起来省事，但组件的对外接口就变成了「你得知道 item 里有什么」，
// 组件内部悄悄依赖 item.publisher.avatar 这种深层字段。
// 拆成一个个具名 property 虽然多打几行，但组件需要什么一眼可见，
// 页面少传一个字段也能立刻看出来。

const { DEFAULT_AVATAR } = require('../../utils/cloud-config');
const { formatPrice } = require('../../utils/util');

Component({
  properties: {
    // 商品 _id，点卡片时原样回传给页面
    goodsId: { type: String, value: '' },
    image: { type: String, value: '' },
    title: { type: String, value: '' },
    // 价格可能是数字也可能是字符串，不做类型约束（type: null = 任意类型）
    price: { type: null, value: '' },
    views: { type: Number, value: 0 },
    campus: { type: String, value: '' },
    avatar: { type: String, value: '' },
    nickname: { type: String, value: '校园用户' },
    // 关键词高亮分段 { before, match, after }，只有搜索页会传。
    // 不传时是 undefined，WXML 里走另一个分支整条渲染。
    highlight: { type: Object },
    // 隐藏卡片底部那一行「头像 + 昵称」。
    // 只有卖家主页会传 true —— 那一页每张卡都是同一个人，
    // 头像和昵称在页头已经大号显示过了，每张卡再重复一遍纯属噪音。
    // 默认 false，首页 / 分类页 / 搜索页的传法一个字都不用改。
    hidePublisher: { type: Boolean, value: false }
  },

  data: {
    // 默认头像。WXML 里读不到 require 进来的常量，只能挂到 data 上再引用
    defaultAvatar: DEFAULT_AVATAR,
    // 格式化后的价格。WXML 里调不了 JS 函数，所以在这里算好。
    priceText: '0'
  },

  // 【为什么格式化放在组件里，而不是让三个页面各自算好再传进来】
  //   这个卡片是首页 / 分类页 / 搜索页共用的。格式化如果写在页面里，
  //   将来新增第四个用到卡片的页面，就会漏掉它 —— 而漏掉的表现是
  //   那个页面上出现 ¥1e+25，不是报错。
  //   放在组件内部，所有用到它的地方自动一起正确。
  //
  // 观察 price 而不是改 price 本身：price 是对外接口（页面按原样传数字），
  // 格式化只影响渲染。这样页面的传参方式一行都不用改。
  observers: {
    price(value) {
      this.setData({ priceText: formatPrice(value) });
    }
  },

  methods: {
    onCardTap() {
      this.triggerEvent('cardtap', { id: this.data.goodsId });
    }
  },

  // observers 在绝大多数基础库上会带着初始值触发一次，但不保证 ——
  // 这里再兜一遍。formatPrice 是纯函数，重复执行没有副作用。
  attached() {
    if (this.data.priceText !== formatPrice(this.data.price)) {
      this.setData({ priceText: formatPrice(this.data.price) });
    }
  }
});
