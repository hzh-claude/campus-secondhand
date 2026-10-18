// pages/delivery/delivery.js
// 配送中心：校内配送的配送员端。
//
// 【为什么是一个页面三个 tab，不是三个页面】
//   这三份列表是同一批数据的三个切面，配送员一天里会在它们之间来回切。
//   拆成三个页面的话，每次切换都是一次 navigateTo + 一次全量重拉，
//   而且「我刚接的那单去哪了」这个问题的答案会散在三个地方。
//
// 后端早就写好了（cloudfunctions/order/index.js 里的 deliveryPool /
// myDeliveries / acceptDelivery / setDeliverySize / finishDelivery /
// deliveryIncome），这个页面只是把它们接到界面上。
//
// 【谁能进这个页面】
//   「我的」页面里那道入口只对配送员显示，但那是【体验】，不是门禁 ——
//   直接改一下启动页面照样能进来。所以这里进来第一件事是问 whoami，
//   不是配送员就什么都不加载（加载了也全是「你不是配送员」）。
//   真正的门禁在云函数，每个 action 第一行都自己查一遍 isAdmin。
const { DELIVERY_STATUS } = require('../../utils/cloud-config');
const { formatPrice } = require('../../utils/util');
const { formatTime } = require('../../utils/util');

// 【这里原来有一个 SIZE_OPTIONS + 一个选大小件的弹窗，已经删掉了】
//
// 老规则下档位要由配送员看实物判：他点「接单」先弹一个
// 「小件 ¥1 / 大件 ¥2」让他选，接完还能「改判」。
// 现在档位由【商品单价】定，接单那一刻云函数就算好了，
// 配送员没有可选项 —— 弹窗留着就是个让人以为自己能定价的摆设。
//
// 顺带一个后果：「改判」也没有了。既然档位不再是人的判断，
// 改判就等于「配送员可以自行改价」，那是绕过定价规则的暗道。
// 云函数那边的 setDeliverySize 也一并删了。

Page({

  data: {
    activeTab: 0,

    // whoami 回来了没。
    // 没回来之前什么都不显示 —— 否则非配送员会先看到一屏空白，
    // 再看到「你不是配送员」，白闪一下。
    checked: false,
    isAdmin: false,

    // 非配送员时显示出来，方便往 ADMIN_OPENIDS 里粘。
    // 这不是调试残留，见 onCopyOpenid 上面的说明。
    myOpenid: '',

    // whoami 自报的云函数版本号、以及白名单里有几个人。
    //
    // 【这不是调试残留】这一屏出现的唯一场景就是「有事不对」，而
    // 「不对」有三种完全不同的原因，修法也完全不同：
    //   v6        → 云函数根本没部署上去
    //   v7 + 0 人 → 部署了，但白名单是空的（改完没重新部署）
    //   v7 + 1 人 → 白名单非空，是对不上号 → 抄错字符了
    // 光看界面上那句「你不是配送员」这三种长得一模一样，
    // 把云函数自己的说法原样摆出来，一眼就能定位，省一整轮来回。
    //
    // adminCount < 0 表示云端根本没这个字段（v6 及更早）。
    cloudVersion: 0,
    adminCount: -1,

    // 线上 order 云函数还是旧版本（连 whoami 都不认识）时置上。
    // 和「你不是配送员」是两回事，文案完全不一样 —— 混在一起说
    // 会让人对着一个其实没问题的白名单查半天。
    needDeploy: false,

    // 累计收入，来自 deliveryIncome。服务端聚合好的，前端不做 reduce
    income: { total: 0, count: 0 },

    poolList: [], // 待接单
    doingList: [], // 配送中
    doneList: [], // 已送达

    // 【只是并发闸，不是「正在加载」的标志】
    // 首屏显不显示「正在确认身份」看的是 checked，不是它 ——
    // 初始值必须是 false，否则 refresh() 开头那道闸会把
    // 页面自己的第一次加载挡掉，整个页面永远停在「确认中」。
    loading: false
  },

  // ============================================================
  // 数据加载
  // ============================================================

  // 刷新整个页面。
  //
  // 第一步只问「我是谁」，第二步才拉数据。
  // 合成一个 Promise.all 看着更省事，但那样非配送员每次进页面
  // 都会白发三个请求、收三条「你不是配送员」。
  refresh() {
    if (this.data.loading) return Promise.resolve();
    this.setData({ loading: true });

    return wx.cloud
      .callFunction({ name: 'order', data: { action: 'whoami' } })
      .then((res) => {
        const result = (res && res.result) || {};

        // whoami 收到非 0 的 code，说明线上这个云函数根本不认识它 ——
        // 也就是新代码还没部署上去。这种情况必须【明说】：
        // 不吭声的话，界面上是一片空白，看的人只会以为是自己权限不够，
        // 而真正的原因是他忘了重新部署。
        if (result.code !== 0) {
          this.setData({
            loading: false,
            checked: true,
            isAdmin: false,
            needDeploy: true
          });
          return;
        }

        if (!result.isAdmin) {
          // 【故意】把自己的 openid 显示出来。whoami 返回它就是为这个
          // （见云函数里那段注释：「它本来就是用来发现『我到底是不是』的」）。
          // 白名单是空的，得先拿到这个值才能填进 ADMIN_OPENIDS ——
          // 这是部署流程里绕不过去的一步，不是调试信息。
          this.setData({
            loading: false,
            checked: true,
            isAdmin: false,
            needDeploy: false,
            myOpenid: result.openid || '',
            cloudVersion: result.version || 0,
            // 云函数没报这个字段就是老版本，用 -1 表示「问不出来」，
            // 不要兜成 0 —— 0 的意思是「白名单确定是空的」，是另一回事。
            adminCount:
              typeof result.adminCount === 'number' ? result.adminCount : -1
          });
          return;
        }

        // 身份确认了，先把它落下来再拉列表 —— 否则 loadLists 失败时
        // isAdmin 还是 false，界面会退回「你不是配送员」，
        // 把一个网络问题说成权限问题，还附赠一串 openid 让人去查白名单。
        this.setData({ isAdmin: true });

        return this.loadLists();
      })
      .catch((err) => {
        console.error('配送中心：whoami 失败', err);
        this.setData({ loading: false, checked: true });
        wx.showToast({ title: '加载失败，请下拉重试', icon: 'none' });
      });
  },

  // 拉三个列表。
  //
  // 单独拆出来是为了让「操作成功后重拉」能直接调它 ——
  // 那条路径上已经确认过身份了，没必要每次操作完再问一遍 whoami。
  loadLists() {
    // 【为什么每个请求都单独兜底，而不是直接 Promise.all】
    //
    //   原来是 Promise.all —— 三个请求里任意一个失败，就一起进 .catch：
    //   配送池、配送中、已完成三个 Tab 同时空，收入显示 0。
    //   用户看到的是「一单都没有」。而实际情况可能只是收入那个接口抖了一下。
    //
    //   ⚠️ 这比「加载失败」更糟：它【给出了一个错误的事实】。
    //      用户会以为自己的配送记录没了，而不是「网络不好」。
    //      页面在最需要可信的时候撒了谎。
    //
    //   所以改成谁失败谁兜底（返回空对象），其余两块照常显示，
    //   最后单独提示是哪一块没拉到。
    //
    // ⚠️ 兜底值必须是 {} 而不是 undefined —— 下面直接 .list / .total 取字段，
    //    兜成 undefined 会在渲染时崩掉，那就从「少显示一块」变成「整页白」。
    const pick = (p) =>
      p.then(
        (res) => ({ ok: true, result: (res && res.result) || {} }),
        (err) => {
          console.error('配送中心：子请求失败', err);
          return { ok: false, result: {} };
        }
      );

    return Promise.all([
      pick(wx.cloud.callFunction({ name: 'order', data: { action: 'deliveryPool' } })),
      pick(wx.cloud.callFunction({ name: 'order', data: { action: 'myDeliveries' } })),
      pick(wx.cloud.callFunction({ name: 'order', data: { action: 'deliveryIncome' } }))
    ])
      .then(([poolRes, mineRes, incomeRes]) => {
        const poolResult = poolRes.result;
        const mineResult = mineRes.result;
        const incomeResult = incomeRes.result;

        // myDeliveries 的查询条件只有 courierOpenid，【不筛状态】——
        // 配送中和已送达是一起回来的，所以在前端按状态拆成两组。
        const mine = mineResult.list || [];

        this.setData({
          loading: false,
          checked: true,
          isAdmin: true,
          needDeploy: false,
          poolList: (poolResult.list || []).map((o) => this.poolItem(o)),
          doingList: mine
            .filter((o) => (o.delivery || {}).status === DELIVERY_STATUS.ACCEPTED)
            .map((o) => this.mineItem(o)),
          doneList: mine
            .filter((o) => (o.delivery || {}).status === DELIVERY_STATUS.DELIVERED)
            .map((o) => this.mineItem(o)),
          income: {
            total: incomeResult.total || 0,
            count: incomeResult.count || 0
          }
        });

        // 把「哪一块没拉到」说出来。只提示失败的那几块，
        // 不写成泛泛的「加载失败」—— 用户下拉重试时至少知道该盯哪儿。
        const failed = [];
        if (!poolRes.ok) failed.push('配送池');
        if (!mineRes.ok) failed.push('我的配送');
        if (!incomeRes.ok) failed.push('收入');
        if (failed.length > 0) {
          wx.showToast({
            title: failed.join('、') + '加载失败，请下拉重试',
            icon: 'none'
          });
        }
      })
      .catch((err) => {
        // 走到这里说明是 setData / map 这类同步错误，不是网络问题（网络已被 pick 吃掉）。
        // 留着是安全网，别删。
        console.error('配送中心：渲染列表失败', err);
        this.setData({ loading: false, checked: true });
        wx.showToast({ title: '加载失败，请下拉重试', icon: 'none' });
      });
  },

  // 池子里的一单。
  //
  // ⚠️ 这里【取不到】sellerPhone 和买家的姓名/电话/详细地址 ——
  //    不是这里忘了取，是云函数的 poolView 白名单根本没给。
  //    池子是所有配送员共看的，想加回什么字段，去改 poolView，
  //    别在这里找。
  poolItem(o) {
    const goods = o.goods || {};
    const delivery = o.delivery || {};

    return {
      id: o._id,
      goodsId: o.goodsId,
      title: goods.title || '商品已删除',
      image: goods.image || '',
      // 商品价格挂在这里是为了核对配送费对不对（商品 ¥250 该配 ¥2）。
      // 必须过 formatPrice：这是【下单那一刻的快照】，
      // 商品后来被改成 1e25 这类脏数据，快照里存的就是那个值。
      price: formatPrice(goods.price),
      // 取货点 = 商品自己的交易地点（卖家发布时选的），
      // 不是卖家的常驻宿舍 —— 东西在哪就去哪取。
      // 新数据是「松园·松一」这种整串（见 utils/campus.js），老数据只有园区名，
      // 两种都直接显示，不需要在这里拆。
      pickupCampus: goods.campus || '未填写地点',
      dropCampus: ((delivery.address || {}).campus) || '未填写宿舍',

      // 接这一单能拿多少。下单时就按商品单价定好了，配送员在池子里
      // 就该看见 —— 他判断「值不值得跑这一趟」靠的就是这个数，
      // 而池子卡片上原来只有商品价格，没有配送费。
      //
      // ⚠️ 读订单里【冻结】的 delivery.fee，不拿 size 现查价目表：
      //    价目表改过之后，老单子显示的必须是老价格。
      fee: delivery.fee || 0,

      // 卖家确认订单的时间。这一单是那一刻才进池子的，
      // 对配送员来说这才是「什么时候有的这一单」
      time: formatTime(o.finishTime)
    };
  },

  // 我接的单（配送中 / 已送达共用一套字段，只有按钮不同）。
  //
  // 这里才有手机号 —— 接了单才看得到，这是【接口层面】的约定
  // （myDeliveries 的查询条件本身就限定了只返回我接的单），
  // 不是这里少写了几行渲染。所以任何「大厅里也把电话显示出来吧」
  // 的需求，改的都不是这个文件。
  mineItem(o) {
    const goods = o.goods || {};
    const delivery = o.delivery || {};
    const address = delivery.address || {};
    const delivered = delivery.status === DELIVERY_STATUS.DELIVERED;

    return {
      id: o._id,
      goodsId: o.goodsId,
      title: goods.title || '商品已删除',
      image: goods.image || '',
      // 商品价格挂在这里是为了核对配送费对不对（商品 ¥250 该配 ¥2）。
      // 必须过 formatPrice：这是【下单那一刻的快照】，
      // 商品后来被改成 1e25 这类脏数据，快照里存的就是那个值。
      price: formatPrice(goods.price),
      pickupCampus: goods.campus || '未填写地点',

      // 取货电话。卖家在「确认卖出」那一步留的，写进了订单快照。
      // 卖家以后换了号，这一单显示的仍是当时的号 —— 这是对的，
      // 订单是历史凭证。
      sellerPhone: delivery.sellerPhone || '',

      // 收货信息。下单那刻的地址快照，买家之后改地址不影响这一单
      dropName: address.name || '',
      dropPhone: address.phone || '',
      dropCampus: address.campus || '未填写宿舍',
      dropDetail: address.detail || '',

      // ⚠️ 读订单里【冻结】的 fee，不拿 DELIVERY_FEE[size] 现算 ——
      //    价目表改过之后，老单子显示的必须是老价格
      fee: delivery.fee || 0,

      isDoing: !delivered,
      time: formatTime(delivered ? delivery.deliverTime : delivery.acceptTime)
    };
  },

  // ============================================================
  // 操作
  // ============================================================

  onTabChange(e) {
    this.setData({ activeTab: e.detail.index });
  },

  // 接单。
  //
  // 【为什么要确认弹窗，而以前不用】
  //   以前弹的是「小件 ¥1 / 大件 ¥2」那个 actionSheet —— 它本身
  //   就是一次明确的选择，再叠一层「确认？」就是三重交互了。
  //   现在没有任何可选项，光点一下按钮就接单，那一下太轻了：
  //   接单是【不可逆】的（没有退单入口），得让人看清代价再点。
  //
  // 弹窗里说清三件事：能挣多少、送到哪、以及【接了就退不掉】。
  //   最后那句尤其要说 —— 不说的话，配送员会以为跟「已送达」一样
  //   后面还有环节，等真到了搬不动的时候才发现没有出口。
  onAcceptTap(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;

    // 从列表里查，不从 dataset 再带一份 ——
    // 带两份就有「显示的那个数」和「弹窗里的数」不一致的风险。
    const item = this.data.poolList.find((o) => o.id === id);
    if (!item) return;

    wx.showModal({
      title: '确认接单',
      content:
        '配送费 ¥' + item.fee + '，送到' + item.dropCampus + '。\n' +
        '接单后这一单就归你了，没有退回的入口。',
      confirmText: '接单',
      success: (res) => {
        if (!res.confirm) return;
        this.callDelivery('acceptDelivery', id, '接单成功');
      }
    });
  },

  // 送达。
  //
  // 文案必须写清楚「钱已当面收妥」：云函数里这一步标记的是
  // 「送到了」，同时也就意味着「钱收了」。文案写成「标记为已送达」，
  // 配送员会以为这只是个进度记录，钱还没收到就点了。
  onFinishTap(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;

    wx.showModal({
      title: '确认送达',
      content: '确认货已送到、配送费已当面收妥？',
      confirmText: '已送达',
      success: (res) => {
        if (!res.confirm) return;
        this.callDelivery('finishDelivery', id, '已送达');
      }
    });
  },

  // 接单 / 送达 的公共调用逻辑。
  //
  // 参数由这个函数自己拼，不给调用方留拼 data 的口子 ——
  // 这样 action/orderId 永远在正确的位置上，不会因为调用方手滑漏掉。
  // （和 pages/my_sold/my_sold.js 的 callOrder 同一个套路。）
  //
  // 【原来这里还有个 extra 参数】
  //   因为 acceptDelivery 要额外传 size，setDeliverySize 也要。
  //   两个都删了，所以 extra 也跟着删 —— 留着一个永远传 undefined 的
  //   形参，下一个人会以为还有别的地方在用它。
  callDelivery(action, orderId, successText) {
    // mask:true 挡住二次点击。但【真正的并发门禁在云函数】——
    // 两个人同时点接单，慢的那个会收到「这单已经被接走了」。
    wx.showLoading({ title: '处理中...', mask: true });

    wx.cloud
      .callFunction({
        name: 'order',
        data: { action, orderId }
      })
      .then((r) => {
        wx.hideLoading();
        const result = (r && r.result) || {};

        if (result.code !== 0) {
          // 原样透传，不吞成「操作失败」：抢单失败时那句
          // 「这单已经被接走了」在告诉配送员该刷新了，
          // 而「操作失败」什么都没说。
          wx.showToast({ title: result.message || '操作失败', icon: 'none' });
          // 失败多半是因为状态变了（别人抢走了 / 已经送过了），
          // 顺手重拉一次，把界面上已经过期的单子刷掉
          this.loadLists();
          return;
        }

        wx.showToast({ title: successText, icon: 'success' });
        this.loadLists();
      })
      .catch((err) => {
        wx.hideLoading();
        console.error(action + ' 失败：', err);
        wx.showToast({ title: '网络异常，请重试', icon: 'none' });
      });
  },

  onGoodsTap(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` });
  },

  // 拨电话。配送员这一趟最常用的动作就是这个，
  // 让他能直接点号码，而不是看着一串数字手动拨。
  //
  // 号码从 dataset 里来（就是界面上显示的那一串），不另存一份 ——
  // 存两份就有「显示的号」和「拨出去的号不是同一个」的风险，
  // pages/concat/concat.js 正是为这个栽过一次。
  onCallTap(e) {
    const { phone } = e.currentTarget.dataset;
    if (!phone) return;

    wx.makePhoneCall({
      phoneNumber: String(phone),
      // 用户取消拨号也会走 fail，那是正常操作，不该弹错误提示。
      // 留个空函数是【故意的】，不是忘了写。
      fail: () => {}
    });
  },

  // 长按复制自己的 openid。
  //
  // 【这不是调试残留】ADMIN_OPENIDS 是空数组，谁进去都是「你不是配送员」。
  // 要把它填上，就必须先拿到 openid。让这一步能长按复制，
  // 好过让人对着屏幕手抄 28 位字符 —— 云函数注释里专门记着
  // 「这个项目为手抄 openid 抄进一个假字符栽过一次」。
  onCopyOpenid() {
    if (!this.data.myOpenid) return;
    wx.setClipboardData({ data: this.data.myOpenid });
  },

  // ============================================================
  // 生命周期
  // ============================================================

  onLoad() {
    this.refresh();
  },

  onShow() {
    // 首屏还没确认完身份（checked 还是 false）时什么都不做，
    // 避免开局拉两次。onShow 一定在 onLoad 的异步回来之前触发，
    // 所以这一道就够 —— 用 loading 判断反而不行，它是并发闸，
    // 首屏那一刻的值说明不了任何事。
    if (!this.data.checked) return;
    // 必须放在 onShow：从详情页返回、或者刚在别处处理完一单回来，
    // 列表都该是新的
    this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().then(() => wx.stopPullDownRefresh());
  },

  onShareAppMessage() {

  }
});
