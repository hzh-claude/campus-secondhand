// pages/detail/detail.js
const {
  COLLECTION,
  GOODS_STATUS,
  DEV_ALLOW_SELF_BUY,
  DEFAULT_AVATAR,
  deliveryFeeOf,
  DELIVERY_LARGE_PRICE,
  PRICE_MAX,
  BRAND
} = require('../../utils/cloud-config');
const { formatTime, formatPrice, isValidPrice } = require('../../utils/util');
const { unitOf, isValidQuantity } = require('../../utils/categories');
const { markGoodsChanged } = require('../../utils/goods-refresh');

// 底部购买按钮的文案，由商品状态决定。
// 放在 JS 里算而不是写进 WXML 的三元表达式 ——
// 四个状态嵌套三元会变成一坨没法读的字符，改一个条件要数半天括号。
function buyButtonText(status) {
  if (status === GOODS_STATUS.SOLD) return '已售出';
  if (status === GOODS_STATUS.OFF_SALE) return '已下架';
  if (status === GOODS_STATUS.LOCKED) return '已被预订';
  return '立即购买';
}

// 配送费那句解释。放在 JS 里拼，不写进 WXML 的三元表达式 ——
// 和上面 buyButtonText 同一个理由：要引用商品价格、分界线、算出来的
// 费用三样东西，塞进 {{}} 里就没人看得懂了。
//
// 【为什么值得单独写一句】
//   买家掏钱之前有权知道这个数是怎么来的。商品刚好卡在 ¥200 附近时，
//   「凭什么他是 1 块我是 2 块」这种疑问在页面上答掉，
//   比等到收货时由配送员站在宿舍门口口头答掉便宜得多。
function buildFeeNote(price) {
  const over = Number(price) > DELIVERY_LARGE_PRICE;
  return (
    // 用 formatPrice 而不是原样拼：库里可能存着 1e25 这种历史脏数据，
    // 原样拼出来就是「这件商品标价 ¥1e+25」。
    '这件商品标价 ¥' +
    formatPrice(price) +
    '，' +
    (over ? '超过了' : '没超过') +
    ' ¥' +
    DELIVERY_LARGE_PRICE +
    ' 这条线，所以配送费是 ¥' +
    deliveryFeeOf(price) +
    '。收货时当面付给配送员。'
  );
}

Page({

  /**
   * 页面的初始数据
   */
  data: {
    goodsId: '',
    currentImageIndex: 0,
    isFavorite: false,
    // 收藏总数：来自云函数实时 count，不用 goods.favorites 那个冗余字段
    favoriteCount: 0,
    // 是不是我自己发的商品（服务端判定），决定底部按钮的形态
    isOwner: false,
    // 开发开关透传到页面：WXML 里读不到 require 的值，只能挂到 data 上
    devSelfBuy: DEV_ALLOW_SELF_BUY,
    // 分享卡片的图片地址（https 临时链接，进页面时就取好）
    // 见 prepareShareImage —— 它【不能】等到分享那一刻才取
    shareImage: '',
    // 默认头像。卖家没设头像时由 WXML 兜底显示。
    // WXML 里读不到 require 进来的常量，只能挂到 data 上再引用
    defaultAvatar: DEFAULT_AVATAR,
    // 请求进行中标记：防连点
    favoriteBusy: false,
    // 打开聊天也要防连点：连点三下会发三次 openConversation，
    // 万一第一条会话还没建完，后两条查不到就会各建一个 ——
    // 同一件商品出现三个一模一样的会话
    contactBusy: false,
    buying: false,
    // 购买按钮的文案，随商品状态变化
    buyText: '立即购买',
    // 标价不合法（超出上限或不是有效数字）。历史脏数据专用，正常商品恒为 false
    priceBad: false,

    // ===== 下单弹层 =====
    //
    // 为什么下单要开一个弹层，而不是原来那个 wx.showModal 确认框？
    //   showModal 只能显示一段文字 + 两个按钮。现在买家要做的选择
    //   从 0 个变成了 2 个（怎么拿货、送到哪），还可能要看地址列表 ——
    //   这些它装不下。
    showOrderSheet: false,
    // 取货方式。只有两个值，和云函数 order.create 里判断的约定一致：
    //   'self'     自提（和以前完全一样，订单上不会多出 delivery 字段）
    //   'delivery' 校内配送（必须同时有 addressId）
    // 这是个「两端约定」，前端传字符串、云函数认字符串，
    // 所以这里不定义常量 —— 定义了也管不住 WXML 里那些字面量比较，
    // 反而会让人以为只有一处要改。
    deliveryType: 'self',
    // 收货地址列表（选配送时才加载）
    addressList: [],
    addressId: '',
    addressLoading: false,
    // 这一件商品的配送费 —— 加载到商品价格之后算出来的【确切金额】。
    //
    // 【这里以前挂的是价目表 {small:1, large:2}】
    //   因为老规则下配送员看实物判大小，下单时根本算不出买家该付几块，
    //   界面上只能把两个价都列出来，再附一句「具体多少等配送员定」。
    //   现在档位由商品单价定，算得出确切数字，价目表就不用露脸了。
    //   算法在 utils/cloud-config.js 的 deliveryFeeOf，和云函数同一套规则。
    deliveryFee: 0,
    // 上面那个金额是怎么来的，一句话说清楚（内容在 loadGoodsDetail 里拼）。
    // 【故意不提「大件」「小件」】：这两个词现在指的是价格档，和体积无关，
    // 对着 ¥250 的教材说「按大件算」只会让买家更糊涂。
    deliveryFeeNote: '',
    // 商品详情数据（来自云数据库 goods 集合）
    goodsInfo: { images: [], publisher: {} },
    loading: true,
    notFound: false
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad(options) {
    const { id } = options;
    this.setData({ goodsId: id });
    this.loadGoodsDetail(id);
  },

  // 加载商品详情（云数据库 goods 集合）
  loadGoodsDetail(id) {
    if (!id) {
      this.setData({ loading: false, notFound: true });
      return;
    }

    const db = wx.cloud.database();
    db.collection(COLLECTION.GOODS)
      .doc(id)
      .get()
      .then((res) => {
        const item = res.data;
        const publisher = item.publisher || {};
        const goodsInfo = {
          id: item._id,
          title: item.title,
          // price 保持【数字】，配送费要拿它算，分享文案也要用它。
          // priceText 是给界面看的字符串（WXML 里调不了函数）。
          price: item.price,
          priceText: formatPrice(item.price),
          description: item.description || '',
          images: item.images || [],
          category: item.category || '',
          campus: item.campus || '',
          // 数量。老商品没有这个字段，兜底成 1 ——
          // 不能直接用 item.quantity，那样界面上会显示「数量 undefined」。
          quantity: isValidQuantity(item.quantity) ? item.quantity : 1,
          // 量词跟着分类走，【不落库】。
          // 存进商品里的话，卖家改分类时还得记得同步改它，
          // 又多一处能不一致的地方。分类是唯一依据，现算最稳。
          unit: unitOf(item.category),
          condition: item.condition || '',
          // contact 不再读：这个字段已经从发布流程里删掉了。
          // 详情页本来也从来没展示过它 —— 卖家填的联系方式是白填的，
          // 沟通统一走「聊一聊」的站内聊天。
          views: item.views || 0,
          status: item.status,
          publishTime: formatTime(item.createTime),
          // 卖家的 openid。点卖家那一行要跳到他的主页，
          // 主页得靠这个 id 去查他发布的其它商品。
          //
          // 注意 _openid 是云函数 publishGoods 建文档时【显式写进去的】——
          // 云函数用管理员权限写库时微信不会自动加 _openid 字段，
          // 客户端直接写才会。上面 loadPublisherStats 一直在用它，
          // 说明这个字段在库里的确是有的。
          sellerOpenid: item._openid || '',
          publisher: {
            avatar: publisher.avatar || '',
            nickname: publisher.nickname || '校园用户',
            campus: publisher.campus || item.campus || '',
            publishCount: 0,
            soldCount: 0
          }
        };

        // 价格不合法（¥1e+25 这类历史脏数据）时，购买按钮直接变成不可点的
        // 「价格异常」。云函数 order.create 也会拒，但那要等一次网络往返，
        // 而且用户点下去只会看到一句「该商品的价格不合法」，
        // 不如在按钮上就说清楚 —— 前端负责体验，服务端负责安全。
        const priceBad = !isValidPrice(item.price);

        this.setData({
          goodsInfo,
          priceBad,
          buyText: priceBad ? '价格异常' : buyButtonText(item.status),
          // 配送费跟着商品价格走，所以在拿到价格这一刻算一次就够。
          // 买家下单前会看到它，下单后云函数按【订单里冻结的同一个价格】
          // 再算一次 —— 两个数必须一致，规则见 cloud-config 里的注释。
          deliveryFee: deliveryFeeOf(item.price),
          deliveryFeeNote: buildFeeNote(item.price),
          loading: false,
          notFound: false
        });

        this.incViews(item._id);
        this.loadPublisherStats(item._openid);
        this.loadFavorite(item._id);
        this.prepareShareImage((item.images && item.images[0]) || '');
      })
      .catch((err) => {
        console.error('加载商品详情失败：', err);
        this.setData({ loading: false, notFound: true });
        wx.showToast({ title: '商品不存在或已删除', icon: 'none' });
      });
  },

  // 浏览量 +1（云函数内自增，失败不影响页面展示）
  incViews(id) {
    this.setData({ 'goodsInfo.views': (this.data.goodsInfo.views || 0) + 1 });
    wx.cloud
      .callFunction({ name: 'manageGoods', data: { action: 'incViews', id } })
      .catch((err) => console.warn('浏览量自增失败：', err));
  },

  // 卖家发布数 / 卖出数统计
  loadPublisherStats(openid) {
    if (!openid) return;
    const db = wx.cloud.database();
    Promise.all([
      db
        .collection(COLLECTION.GOODS)
        .where({ _openid: openid })
        .count()
        .catch(() => ({ total: 0 })),
      db
        .collection(COLLECTION.GOODS)
        .where({ _openid: openid, status: GOODS_STATUS.SOLD })
        .count()
        .catch(() => ({ total: 0 }))
    ]).then(([publishRes, soldRes]) => {
      this.setData({
        'goodsInfo.publisher.publishCount': publishRes.total || 0,
        'goodsInfo.publisher.soldCount': soldRes.total || 0
      });
    });
  },

  // 读取收藏状态与收藏总数（走云函数，因为要跨用户统计）
  loadFavorite(id) {
    wx.cloud
      .callFunction({ name: 'favorite', data: { action: 'check', goodsId: id } })
      .then((res) => {
        const result = (res && res.result) || {};
        if (result.code !== 0) return;
        this.setData({
          isFavorite: !!result.isFavorite,
          favoriteCount: result.count || 0,
          isOwner: !!result.isOwner
        });
      })
      .catch((err) => console.warn('读取收藏状态失败：', err));
  },

  // 轮播图切换
  onSwiperChange(e) {
    this.setData({ currentImageIndex: e.detail.current });
  },

  // 预览图片
  //
  // 【为什么要先 getTempFileURL】
  //   商品图存在云存储里，images 里是 cloud:// 开头的 fileID。
  //   <image> 组件认这个格式，所以上面那排图能正常显示 ——
  //   但 wx.previewImage 【不认】。它要的是能直接下载的 http 链接。
  //
  //   直接把 fileID 传进去的表现是：点大图【毫无反应】。不报错、不提示、
  //   不跳转，看起来像页面卡了一下。这个坑 chat 和 my_feedback 两处都
  //   分别踩过并留了注释，这一页之前漏了 —— 而它是全应用最常点的页面。
  previewImage(e) {
    const { index } = e.currentTarget.dataset;
    const images = this.data.goodsInfo.images || [];
    if (!images.length) return;

    const tapped = images[index];

    // 老数据里可能有直接存 https 外链的图（见下面 prepareShareImage 的分支）。
    // 那种本来就能预览，只有 cloud:// 的需要换 —— 全是外链时直接开，
    // 连 loading 都不用弹。
    const cloudFiles = images.filter((u) => String(u || '').indexOf('cloud://') === 0);
    if (!cloudFiles.length) {
      wx.previewImage({ current: tapped, urls: images });
      return;
    }

    wx.showLoading({ title: '加载中', mask: true });

    wx.cloud
      .getTempFileURL({ fileList: cloudFiles })
      .then((res) => {
        wx.hideLoading();

        const map = {};
        (res.fileList || []).forEach((f) => {
          // status 为 0 才是成功。失败的那些（文件被删了、权限变了）不放进 map。
          if (f.status === 0 && f.tempFileURL) map[f.fileID] = f.tempFileURL;
        });

        // 【按原顺序还原，并把换失败的整条丢掉】
        //   不能只把成功的拼起来 —— 那样遇到第 2 张失败时，
        //   后面每张的下标都整体前移一位，点第 3 张会预览到第 4 张。
        //   也不能给失败的那些留个空字符串 —— previewImage 里会出现黑图。
        const urls = [];
        let current = '';
        images.forEach((u, i) => {
          const url = map[u] || (String(u || '').indexOf('cloud://') === 0 ? '' : u);
          if (!url) return;
          urls.push(url);
          if (i === index) current = url; // 用户点的那张，可能已经被丢掉
        });

        if (!urls.length) {
          wx.showToast({ title: '图片加载失败', icon: 'none' });
          return;
        }

        // current 为空 = 点中的那张恰好换失败了，退回第一张。
        // 不定位的话预览会从头开始，比退一张更让人摸不着头脑。
        wx.previewImage({ urls, current: current || urls[0] });
      })
      .catch((err) => {
        wx.hideLoading();
        console.error('获取商品图临时链接失败：', err);
        wx.showToast({ title: '图片加载失败', icon: 'none' });
      });
  },

  // 点击收藏 / 取消收藏
  //
  // 原来这里只写 wx.setStorageSync，数据从没进过数据库：
  // 换台手机就没了，也没法统计「这个商品被多少人收藏」。
  // 现在交给云函数，本地只留一个防连点的标记。
  onFavorite() {
    // 第一层防抖：请求还没回来时直接忽略后续点击。
    // 没有它的话，用户连点三下会发三个 toggle 请求，
    // 而 toggle 是「切换」语义 —— 三个请求的结果是「收藏了」，
    // 用户以为自己点了三次收藏，实际状态会来回跳。
    if (this.data.favoriteBusy) return;
    // 开发模式下放行，见 utils/cloud-config.js。
    // 服务端 favorite.toggle 本来就不拦自己收藏自己，所以这里放开就是真能收藏成功。
    if (this.data.isOwner && !DEV_ALLOW_SELF_BUY) {
      wx.showToast({ title: '不能收藏自己的商品', icon: 'none' });
      return;
    }

    this.setData({ favoriteBusy: true });

    wx.cloud
      .callFunction({
        name: 'favorite',
        data: { action: 'toggle', goodsId: this.data.goodsId }
      })
      .then((res) => {
        const result = (res && res.result) || {};
        if (result.code !== 0) {
          wx.showToast({ title: result.message || '操作失败', icon: 'none' });
          return;
        }
        this.setData({
          isFavorite: !!result.isFavorite,
          favoriteCount: result.count || 0
        });
        wx.showToast({ title: result.message, icon: 'success' });
      })
      .catch((err) => {
        console.error('收藏失败：', err);
        wx.showToast({ title: '网络异常，请重试', icon: 'none' });
      })
      .then(() => {
        // 用 then 而不是 finally，兼容性更稳；成功失败都要解锁
        this.setData({ favoriteBusy: false });
      });
  },

  // 联系卖家 → 打开站内聊天
  //
  // 这里原来是个「复制卖家联系方式」的弹窗，现在换成聊天。两个原因：
  //   ① 复制出去之后聊了什么、有没有成交，小程序完全不知道，
  //      等于把交易最关键的环节让给了微信私聊；
  //   ② 让陌生人开口就要你手机号，是二手交易里最典型的风险点。
  //
  // 会话由「商品 + 买家 + 卖家」三者唯一确定，
  // 同一个人对同一件商品只会有一个会话，重复点进来是同一段对话。
  async onContact() {
    if (this.data.contactBusy) return;
    // ⚠️ 守卫必须在【拿锁之前】。反过来的话，弹框那几秒钟里
    //    contactBusy 一直是 true，按钮卡在 loading 态；
    //    用户点「再看看」回来会发现按钮点不动了，而原因看不出来。
    if (!(await getApp().guardVerified())) return;
    this.setData({ contactBusy: true });
    wx.showLoading({ title: '正在打开', mask: true });

    wx.cloud
      .callFunction({
        name: 'chat',
        data: { action: 'openConversation', goodsId: this.data.goodsId }
      })
      .then((res) => {
        wx.hideLoading();
        const result = (res && res.result) || {};
        if (result.code !== 0) {
          wx.showToast({ title: result.message || '打开聊天失败', icon: 'none' });
          return;
        }
        wx.navigateTo({ url: '/pages/chat/chat?id=' + result.conversationId });
      })
      .catch((err) => {
        wx.hideLoading();
        console.error('打开会话失败：', err);
        wx.showToast({ title: '网络异常，请重试', icon: 'none' });
      })
      .then(() => this.setData({ contactBusy: false }));
  },

  // 微信原生客服会话的回调
  //
  // 【这个 handler 只用来「知道用户点过」，不做任何跳转】
  //   open-type="contact" 的行为完全由微信接管：点下去直接进微信官方的
  //   客服会话窗口，不走小程序路由 —— 这儿写 wx.navigateTo 也会被忽略。
  //   （pages/concat 的 onContact 是同一件事，那边注释更详细。）
  //
  //   ⚠️ 它【不是】失败回调。后台没开通客服功能时，点按钮一点反应都没有：
  //      不报错、不弹窗、这个函数也不会被调用。所以别把
  //      「按钮失灵了要提示一下」的逻辑写在这儿 —— 那个事件根本不会发生。
  //      真正的兜底是 pages/concat 页面上那三条联系方式。
  onServiceContact(e) {
    console.log('已进入客服会话：', e.detail);
  },

  // 立即购买 → 打开下单弹层
  async onBuy() {
    // 同上：开发模式放行。真正的放行与否由云函数 order.create 决定，
    // 这边开着的唯一后果是「按钮显示出来了」，服务端不点头照样下不了单。
    if (this.data.isOwner && !DEV_ALLOW_SELF_BUY) {
      wx.showToast({ title: '这是你自己发布的商品', icon: 'none' });
      return;
    }
    // 价格不合法的商品不能买。这里用 showModal 而不是 toast ——
    // toast 一闪而过，用户只会觉得「点了没反应」；
    // 这条要说清楚「不是你操作错了，是这件商品本身有问题」，
    // 并且告诉他该找卖家重新定价，否则他会一直点。
    if (this.data.priceBad) {
      wx.showModal({
        title: '无法购买',
        content:
          '这件商品的标价不合法（超出 ¥' +
          PRICE_MAX +
          ' 或不是有效数字），不能下单。请联系卖家重新编辑商品价格。',
        showCancel: false,
        confirmText: '知道了'
      });
      return;
    }
    if (this.data.goodsInfo.status !== GOODS_STATUS.ON_SALE) {
      wx.showToast({ title: this.data.buyText, icon: 'none' });
      return;
    }

    // 核验守卫。放在【所有商品本身的检查之后】——
    // 一件根本买不了的商品（自己的、价格坏的、已下架的）不该把用户
    // 引去注册。等服务端 order.create 也会再拦一次，
    // 那边返回的是「请先完成校内身份核验后再下单」。
    if (!(await getApp().guardVerified())) return;

    // 每次打开都重置回「自提」。
    //
    // 【故意不记住上次的选择】记住能省一次点击，但代价是：
    // 上次买了台电脑选了配送，这次买本书，弹层一开就是配送 + 上次那个地址，
    // 用户扫一眼就点了确认 —— 白白多付一笔配送费。
    // 省一次点击 vs 让用户为一笔他没打算花的钱买单，选前者。
    this.setData({
      showOrderSheet: true,
      deliveryType: 'self',
      addressId: ''
    });
  },

  onCloseSheet() {
    this.setData({ showOrderSheet: false });
  },

  onSelectSelf() {
    this.setData({ deliveryType: 'self' });
  },

  onSelectDelivery() {
    this.setData({ deliveryType: 'delivery' });
    // 已经有列表就不重复拉：用户可能在「自提 / 配送」之间来回点，
    // 每点一次发一个请求太浪费。真正的刷新交给 onShow ——
    // 从「新增地址」页回来时会经过那里。
    if (this.data.addressList.length === 0) this.loadAddressList();
  },

  // 加载收货地址（走 address 云函数，服务端已按 _openid 过滤）
  loadAddressList() {
    this.setData({ addressLoading: true });

    return wx.cloud
      .callFunction({ name: 'address', data: { action: 'list' } })
      .then((res) => {
        const result = (res && res.result) || {};
        if (result.code !== 0) {
          wx.showToast({ title: result.message || '地址加载失败', icon: 'none' });
          return;
        }

        // 云数据库的字段叫 _id，WXML 里用 id，这里转换一道
        const addressList = (result.list || []).map((item) => ({
          id: item._id,
          name: item.name,
          phone: item.phone,
          campus: item.campus,
          detail: item.detail,
          isDefault: !!item.isDefault
        }));

        // 帮用户预先选好一个：优先默认地址，没有默认就用第一个。
        //
        // 【但要先检查原来选的那个还在不在】不能无脑覆盖 ——
        // 用户手动选了一个非默认地址，然后去新增了另一个地址再回来，
        // 如果不检查，他的选择会被重置回默认地址，而界面上
        // 看不出发生过什么，他会以为是自己点错了。
        let addressId = this.data.addressId;
        const stillThere = addressList.some((a) => a.id === addressId);
        if (!stillThere) {
          const fallback =
            addressList.find((a) => a.isDefault) || addressList[0];
          addressId = fallback ? fallback.id : '';
        }

        this.setData({ addressList, addressId });
      })
      .catch((err) => {
        console.error('加载地址失败：', err);
        wx.showToast({ title: '地址加载失败', icon: 'none' });
      })
      .then(() => this.setData({ addressLoading: false }));
  },

  onSelectAddress(e) {
    const { id } = e.currentTarget.dataset;
    this.setData({ addressId: id });
  },

  // 新增地址。这里只能用 navigateTo，不能跳 address 页 ——
  // 那是「地址管理」，里面能删能改，从下单流程进去会让人迷失。
  onAddAddress() {
    wx.navigateTo({ url: '/pages/address_edit/address_edit' });
  },

  // 确认下单
  confirmOrder() {
    if (this.data.buying) return;

    const { goodsId, deliveryType, addressId } = this.data;

    // 前端的拦截只管体验，真正的把关在云函数（那边会再查一次
    // 地址存不存在、是不是你自己的）。这里挡一下只是为了让用户
    // 早点看到提示，而不是等一个来回的网络请求。
    if (deliveryType === 'delivery' && !addressId) {
      wx.showToast({ title: '请先选择收货地址', icon: 'none' });
      return;
    }

    this.setData({ buying: true });
    wx.showLoading({ title: '下单中...', mask: true });

    wx.cloud
      .callFunction({
        name: 'order',
        data: { action: 'create', goodsId, deliveryType, addressId }
      })
      .then((res) => {
        wx.hideLoading();
        const result = (res && res.result) || {};
        if (result.code !== 0) {
          // 失败最常见的原因是「别人抢先下单了」——
          // 这种情况下页面上的「立即购买」已经过期了。
          // 重新拉一次详情，让按钮立刻变成「已被预订」，
          // 而不是让用户对着一个点不动的按钮反复试。
          wx.showToast({ title: result.message || '下单失败', icon: 'none' });
          // 弹层也要关掉，否则用户会对着一个已经失效的「确认下单」
          // 反复点 —— 商品可能已经被别人抢走了
          this.setData({ showOrderSheet: false });
          this.loadGoodsDetail(goodsId);
          return;
        }

        // 下单成功，商品在服务端已经变成 locked，本地同步一下，
        // 省掉一次网络往返（用户在弹窗上停留的这几秒里，
        // 返回详情页会看到一个还没更新的「立即购买」，容易误点第二次）
        this.setData({
          'goodsInfo.status': GOODS_STATUS.LOCKED,
          buyText: buyButtonText(GOODS_STATUS.LOCKED),
          showOrderSheet: false
        });

        // 商品已经不在在售池里了（别人也不能再买），留个标记，
        // 让首页 / 分类页 / 卖家主页 / 搜索页下次显示时重查一遍。
        // 少了这一句，用户退回去会看到一件还挂在架上、点进去却买不了的商品。
        markGoodsChanged();

        wx.showModal({
          title: '下单成功',
          // 配送单要额外说清楚两件事：还要等配送员接单，
          // 以及那笔配送费是收货时当面付的。
          // 不说的话，用户会在付款那一刻才发现还要多给钱。
          content:
            deliveryType === 'delivery'
              ? '商品已为你保留，等待卖家确认。卖家确认后会安排配送，配送费在收货时当面支付。'
              : '商品已为你保留，等待卖家确认。可在「我的 → 我买到的」查看。',
          showCancel: false,
          confirmText: '知道了',
          success: () => wx.navigateBack()
        });
      })
      .catch((err) => {
        wx.hideLoading();
        console.error('下单失败：', err);
        wx.showToast({ title: '网络异常，请重试', icon: 'none' });
      })
      .then(() => this.setData({ buying: false }));
  },

  // 自己的商品 → 跳到「我发布的」去管理
  //
  // 只能用 navigateTo，不能用 switchTab：
  // switchTab 只认 app.json 的 tabBar.list 里声明过的页面（首页/发布/我的），
  // my_push 是个普通页面，用 switchTab 会静默失败 —— 不报错、不跳转，什么都不发生。
  onManage() {
    wx.navigateTo({ url: '/pages/my_push/my_push' });
  },

  // 查看卖家主页：跳过去看这个卖家发布的全部在售商品
  //
  // 【为什么昵称和头像要塞进 URL】
  //   卖家主页一进去就要发一次数据库查询，回来之前页面是空的。
  //   只传 openid 的话，标题和头像会有半秒钟显示成「校园用户」+ 默认头像，
  //   然后再跳成真名 —— 这种闪一下比慢一点更难受。
  //   详情页此刻【正好拿着】卖家的昵称头像（就是刚点的那一行），
  //   顺手带过去当首屏内容。
  //
  //   但带过去的值【只是占位，不是权威】：卖家主页查到商品后会用
  //   商品里那份 publisher 覆盖掉。优先级是明确的 ——
  //   查出来的（新）胜过 URL 里的（旧），见 seller.js 的 applyGoods。
  //
  //   encodeURIComponent 不能省：昵称里出现 & # 空格 会把 query 截断，
  //   中文虽然多数情况下能过，但不编码就是在赌。
  onViewSeller() {
    const { sellerOpenid, publisher } = this.data.goodsInfo;

    if (!sellerOpenid) {
      wx.showToast({ title: '暂时拿不到卖家信息', icon: 'none' });
      return;
    }

    const query = [
      'openid=' + encodeURIComponent(sellerOpenid),
      'nickname=' + encodeURIComponent(publisher.nickname || ''),
      'avatar=' + encodeURIComponent(publisher.avatar || '')
    ].join('&');

    wx.navigateTo({ url: '/pages/seller/seller?' + query });
  },

  // ============================================================
  // 分享
  // ============================================================
  //
  // 商品分享是这个小程序最主要的传播方式 —— 同学之间转一件东西，
  // 比任何首页推荐都管用。
  //
  // 【为什么要在进页面时就把图取好】：
  // onShareAppMessage 必须【同步返回】一个对象，里面不能 await。
  // 所以临时链接只能提前备好，不能等分享那一刻现取。
  //
  // 【为什么不能直接把 fileID 填进 imageUrl】：
  // 官方文档说 imageUrl 可以是「本地文件路径、代码包文件路径或者网络图片路径」，
  // 没有 cloud:// 这一项；社区有开发者反馈填 fileID 图片不显示。
  // 而 cloud:// 恰恰是本项目商品图的存储格式 —— 所以必须转一道。
  prepareShareImage(fileID) {
    const id = String(fileID || '');

    // 不是云存储文件。老数据里有直接存外链图片的，
    // 那种本身就是 https 链接，拿来就能用
    if (id.indexOf('cloud://') !== 0) {
      this.setData({ shareImage: id });
      return;
    }

    wx.cloud
      .getTempFileURL({ fileList: [id] })
      .then((res) => {
        const item = (res.fileList || [])[0] || {};
        // 取不到就留空。留空【不是】没有分享图 ——
        // 微信会自动拿页面截图兜底，所以这里不需要准备占位图。
        this.setData({ shareImage: item.tempFileURL || '' });
      })
      .catch((err) => {
        // 失败只是分享图变成截图，不影响任何主流程，所以只 warn 不 toast
        console.warn('获取分享图临时链接失败，将用页面截图兜底：', err);
      });
  },

  onShareAppMessage() {
    const info = this.data.goodsInfo;
    // 价格塞进标题：同学在群里刷到这条时，最先想知道的就是多少钱。
    // 要点进来才知道的话，多半就划过去了。
    // 用 priceText 不用 price：分享出去的是纯文本，1e25 会变成
    // 群里那行「¥1e+25 某同学能飞」，比页面上更难看，而且改不了
    const title = info.title
      ? '¥' + info.priceText + ' ' + info.title
      : BRAND.APP_NAME + ' · 校园二手交易';

    return {
      title,
      // path 显式写出来。不写的话微信也默认分享当前页，
      // 但当前页可能是带了一堆参数的版本，写死更清楚
      path: '/pages/detail/detail?id=' + this.data.goodsId,
      // 空字符串会让微信去加载一个空地址，所以为空时传 undefined（等于不传）
      imageUrl: this.data.shareImage || undefined
    };
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
    // 从「新增地址」页返回时弹层还开着，把新地址刷进来。
    // 少了这一句，用户新增完地址回来会发现列表里还是没有它 ——
    // 而列表本身并没有错，只是没人告诉它要重新查一次。
    if (this.data.showOrderSheet) this.loadAddressList();
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
    this.loadGoodsDetail(this.data.goodsId);
    wx.stopPullDownRefresh();
  },

  /**
   * 页面上拉触底事件的处理函数
   */
  onReachBottom() {

  }

  // 这个文件底部原来还有一个空的 onShareAppMessage。
  // 对象字面量里同名属性【后者覆盖前者】，留着它会把上面写好那个
  // 悄悄换成空的 —— 分享不生效，还找不到原因（两份代码长得一模一样）。
  // 所以在这里删掉了，只保留上面那一份。
})