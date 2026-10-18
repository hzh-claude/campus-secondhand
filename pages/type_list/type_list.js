// pages/type_list/type_list.js
const { COLLECTION, GOODS_STATUS, PAGE_SIZE } = require('../../utils/cloud-config');
const { CAMPUS_GROUPS, campusFilterValues } = require('../../utils/campus');
const { consumeGoodsChanged } = require('../../utils/goods-refresh');

// 排序映射表：把界面上的排序选项翻译成数据库字段
// 以后加排序方式，只在这张表里加一行即可
const SORT_MAP = {
  latest: { field: 'createTime', order: 'desc' }, // 最新发布
  price_asc: { field: 'price', order: 'asc' }, // 价格最低
  price_desc: { field: 'price', order: 'desc' }, // 价格最高
  views: { field: 'views', order: 'desc' } // 浏览最多
};

Page({
  data: {
    categoryId: 0,
    categoryName: '',
    sortType: 'latest',
    sortOptions: [
      { text: '最新发布', value: 'latest' },
      { text: '价格最低', value: 'price_asc' },
      { text: '价格最高', value: 'price_desc' },
      { text: '浏览最多', value: 'views' }
    ],
    // 交易地点筛选。
    //
    // 【筛的是园区，不是楼栋】—— 列表页面的筛选粒度停在园区这一级。
    // 精确到楼栋的话，20 个选项里挑一个，比翻列表还累；
    // 楼栋是在商品卡片上看的（「松园·松一」），不是用来筛的。
    //
    // 选项从 utils/campus.js 派生，不再手写一份。
    // 「全部宿舍」改叫「全部地点」—— 和发布页那个字段名统一。
    // 这里筛的是商品的【交易地点】，不是用户的常驻宿舍，两个概念。
    campusOptions: [{ text: '全部地点', value: 'all' }].concat(
      CAMPUS_GROUPS.map((g) => ({ text: g.name, value: g.name }))
    ),
    selectedCampus: 'all',
    // 原生 picker 需要「选中索引 + 显示文字」这两个值
    sortIndex: 0,
    sortLabel: '最新发布',
    campusIndex: 0,
    campusLabel: '全部地点',
    // 商品列表
    goodsList: [],
    // 分页与加载状态
    page: 0,
    loading: false,
    isEnd: false
  },

  onLoad(options) {
    const { id, name } = options;
    const categoryName = decodeURIComponent(name || '');

    this.setData({
      categoryId: id,
      categoryName
    });

    wx.setNavigationBarTitle({
      title: categoryName || '分类列表'
    });

    this.loadGoodsList(true);
  },

  // 查询商品列表（reset 为 true 时从头加载）
  // 这里是【只读公开数据】，所以直连数据库，不走云函数
  loadGoodsList(reset) {
    if (this.data.loading) return Promise.resolve();
    if (!reset && this.data.isEnd) return Promise.resolve();

    this.setData({ loading: true });
    const page = reset ? 0 : this.data.page;

    const db = wx.cloud.database();
    const _ = db.command;

    // ① 动态拼查询条件：分类、交易地点都是可选的
    const where = { status: GOODS_STATUS.ON_SALE };
    if (this.data.categoryName) {
      where.category = this.data.categoryName;
    }
    if (this.data.selectedCampus !== 'all') {
      // 【必须用 in，不能用等号】
      //   商品的 campus 存的是整串：「松园·松一」。
      //   写 where.campus = '松园' 的话，加了楼栋的新商品一条都筛不出来 ——
      //   界面上的现象是「松园里只有几件老商品」，而不是报错，
      //   没人会往查询条件上想。
      //   campusFilterValues 会把「松园」本身（老数据的值）和
      //   「松园·松一…松五」全列出来，两种格式都能筛到。
      where.campus = _.in(campusFilterValues(this.data.selectedCampus));
    }

    // ② 排序
    const sort = SORT_MAP[this.data.sortType] || SORT_MAP.latest;

    return db
      .collection(COLLECTION.GOODS)
      .where(where)
      .orderBy(sort.field, sort.order)
      .skip(page * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .get()
      .then((res) => {
        const list = (res.data || []).map((item) => ({
          id: item._id,
          title: item.title,
          price: item.price,
          image: (item.images && item.images[0]) || '',
          campus: item.campus,
          views: item.views || 0,
          publisher: item.publisher || { avatar: '', nickname: '校园用户' }
        }));

        this.setData({
          goodsList: reset ? list : this.data.goodsList.concat(list),
          page: page + 1,
          isEnd: list.length < PAGE_SIZE,
          loading: false
        });
      })
      .catch((err) => {
        console.error('加载商品列表失败：', err);
        this.setData({ loading: false });
        wx.showToast({ title: '加载失败，请下拉重试', icon: 'none' });
      });
  },

  // 排序方式改变：重置分页后重新查
  // 原生 picker 的 e.detail.value 是【选项索引】
  onSortChange(e) {
    const index = Number(e.detail.value);
    const option = this.data.sortOptions[index];
    if (!option) return;

    this.setData({
      sortIndex: index,
      sortLabel: option.text,
      sortType: option.value
    });
    this.loadGoodsList(true);
  },

  // 宿舍筛选改变：重置分页后重新查
  onCampusChange(e) {
    const index = Number(e.detail.value);
    const option = this.data.campusOptions[index];
    if (!option) return;

    this.setData({
      campusIndex: index,
      campusLabel: option.text,
      selectedCampus: option.value
    });
    this.loadGoodsList(true);
  },

  // 点击商品
  // 点击商品卡片。id 来自 goods-card 组件的 cardtap 事件（e.detail.id），
  // 【不是】e.currentTarget.dataset —— 组件已经不用 data-id 了。
  // 抄成 dataset 拿到的是 undefined，跳转变成 ?id=undefined，
  // 详情页只会说「商品不存在」，看不出是这里的问题。
  onGoodsTap(e) {
    const { id } = e.detail;
    wx.navigateTo({
      url: `/pages/detail/detail?id=${id}`
    });
  },

  onReady() {},

  // 从详情页下单回来时，那件商品已经从在售池里出去了，
  // 但这一页的列表还是离开时的样子 —— 点进去才发现买不了。
  // 只在【真的改动过商品】时重查，理由见 utils/goods-refresh.js 顶部。
  onShow() {
    if (consumeGoodsChanged()) {
      this.loadGoodsList(true);
    }
  },

  onHide() {},

  onUnload() {},

  onPullDownRefresh() {
    this.loadGoodsList(true).then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    this.loadGoodsList(false);
  },

  onShareAppMessage() {}
});
