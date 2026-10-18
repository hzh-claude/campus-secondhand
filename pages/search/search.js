// pages/search/search.js
// 关键词搜索商品
const { COLLECTION, GOODS_STATUS, PAGE_SIZE } = require('../../utils/cloud-config');
const { consumeGoodsChanged } = require('../../utils/goods-refresh');

// 关键词里的正则元字符必须转义。
//
// db.RegExp 是拿字符串去构造正则，`(` `+` `*` 这些字符会让构造直接失败，
// 或者构造出一个语义完全不同的正则：
//   搜「(全新)」→ 未闭合的分组，直接抛错
//   搜「a+b」  → 变成「一个或多个 a 后面跟 b」，结果莫名其妙
// 现象是「某些词搜不了，换个词又好了」，几乎没人会联想到是转义问题。
//
// 注意 `-` 不在这个字符类里：它只在 [] 内部才有特殊含义，这里不需要。
function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 把标题按关键词切成「前 / 词 / 后」三段，给 WXML 做高亮。
//
// 为什么在这儿算：WXML 里没法调 JS 函数，所有派生数据都得提前算好。
//
// 找不到匹配就返回 null，让 WXML 走「整条不高亮」那条路。
// 命中可能来自【描述】而不是标题 —— 那种情况下标题里确实没有这个词，
// 不高亮才是对的，不是 bug。
function splitByKeyword(title, keyword) {
  const text = String(title || '');
  const kw = String(keyword || '');
  if (!kw) return null;

  // 两边都转小写再找位置。转小写【不改变长度】，
  // 所以用原字符串按这个下标切片是安全的 —— 这是能这么写的前提。
  const index = text.toLowerCase().indexOf(kw.toLowerCase());
  if (index < 0) return null;

  return {
    before: text.slice(0, index),
    match: text.slice(index, index + kw.length),
    after: text.slice(index + kw.length)
  };
}

// ============================================================
// 搜索历史
// ============================================================
//
// 【只存在这台手机上，一个字都不上传】
//   存在 wx 的本地缓存里，服务端不知道你搜过什么。
//   这是有意的：搜索词是最容易夹带个人信息的东西
//   （「XX 宿舍 钥匙」「XX 楼 二手电动车」），而「少打几个字」
//   这点便利，完全不值得把每个人的搜索词全量收到服务器上。
//   代价是换手机、删小程序、点「设置 → 清除缓存」就没了 ——
//   对这个功能来说，这个代价是划算的。
//
//   也正因为没离开过设备，隐私政策「收集哪些信息」那一节【不该】写它：
//   那一节的标题是「收集」。政策第五节里有一条讲怎么删掉它。
//
// 【为什么不再单独开一个 utils/search-history.js】
//   goods-refresh 之所以独立成文件，是因为它有 5 个生产者和 4 个消费者。
//   这个目前只有搜索页一个页面在用，拆出去只是多一层跳转。
//   等真有第二个页面要用（比如首页搜索框下面也想显示历史）再拆，不提前拆。
const HISTORY_KEY = 'searchHistory';

// 最多留 10 条。再多的话引导态那一屏会被历史占满，
// 「输入关键词，找找同学在卖什么」这句提示就被挤没了 ——
// 历史是捷径，不该把主路径盖住。
const HISTORY_MAX = 10;

// 读历史。
//
// 整个套在 try/catch 里：wx.getStorageSync 在缓存被写坏、
// 或某些环境的存储异常时会抛。历史是纯锦上添花的功能，
// 读不出来应该表现为「这次没有历史」，绝不能把整个搜索页带崩。
//
// Array.isArray + 类型过滤两道兜底，防的是「存进去的不是字符串数组」：
// 比如以后有人手滑 writeHistory 了个对象进去。不拦的话
// WXML 里 wx:for 会渲染出 [object Object]，点一下就拿它去搜了。
function readHistory() {
  try {
    const list = wx.getStorageSync(HISTORY_KEY);
    return Array.isArray(list)
      ? list.filter((k) => typeof k === 'string' && k)
      : [];
  } catch (err) {
    console.warn('读取搜索历史失败：', err);
    return [];
  }
}

// 写历史。同样吞掉异常 —— 存不下就存不下，
// 不能让「搜索」这个主功能因为记不上历史而失败。
function writeHistory(list) {
  try {
    wx.setStorageSync(HISTORY_KEY, list);
  } catch (err) {
    console.warn('保存搜索历史失败：', err);
  }
}

// 把一个词放进历史：重复的挪到最前、只留一条，超上限的从尾部丢掉。
//
// 去重【忽略大小写】：搜索本身就是 options:'i' 忽略大小写的，
// 「iPhone」和「iphone」搜出来的东西一模一样。留着两条的话，
// 用户看着像两个不同的词，点哪个结果都一样。
// 但存下来的是【这次输的那个写法】—— 他输 iPhone 就该显示 iPhone，
// 不该被上一次存的 iphone 顶掉。
function makeHistory(list, keyword) {
  const lower = keyword.toLowerCase();
  return [keyword]
    .concat(list.filter((k) => k.toLowerCase() !== lower))
    .slice(0, HISTORY_MAX);
}

Page({

  data: {
    // 已经提交搜索的关键词（决定查什么）
    keyword: '',
    // 输入框里显示的值（用户可能改了但还没回车）
    inputValue: '',
    goodsList: [],
    page: 0,
    loading: false,
    isEnd: false,
    // 「还没搜过」和「搜了但没结果」是两种不同的空状态，
    // 用同一个「暂无商品」会让人以为搜坏了
    searched: false,
    // 搜索历史（只在本机）。在 data 里就地初始化，而不是等 onLoad ——
    // onLoad 第一行就是「没带关键词就 return」，读历史很容易被写在它后面，
    // 结果是从首页带词进来时列表是空的，非得点一次 × 才冒出来。
    // 写在这儿就没有这个先后顺序可踩了。onShow 里还会再读一次保鲜。
    history: readHistory(),
    // 历史面板开着没有。只有它和 history 同时非空，面板才真的渲染 ——
    // 没有历史的人点开搜索框不应该弹出一个空壳。
    historyVisible: false
  },

  onLoad(options) {
    const keyword = decodeURIComponent((options && options.keyword) || '').trim();
    if (!keyword) return;

    this.setData({ keyword, inputValue: keyword });
    // 从首页搜索框回车进来的这一下也算一次搜索，得记进历史 ——
    // 不然「首页搜的词」和「搜索页里搜的词」会记成两套，
    // 用户回到引导态发现少了几个，只会觉得这功能时灵时不灵。
    this.recordHistory(keyword);
    this.loadGoodsList(true);
  },

  // 把一个词记进历史（内存 + 本地缓存各一份）
  recordHistory(keyword) {
    const history = makeHistory(this.data.history, keyword);
    this.setData({ history });
    writeHistory(history);
  },

  // ============================================================
  // 历史面板的开关
  // ============================================================

  // 点搜索框 → 历史滑出来
  //
  // 【为什么 focus 和 click-input 都要绑】
  //   光绑 focus 有个死角：面板被收起时输入框往往【还是聚焦的】
  //   （点遮罩并不会让它失焦），用户再点一次搜索框，
  //   focus 不会二次触发 —— 点了没反应，只能先点别处再点回来。
  //   click-input 是「点了一下输入区」，每点一次都响，正好补上这个洞。
  //
  // 没有历史就不开：弹一个空面板出来，比不弹更让人困惑。
  onSearchFocus() {
    if (this.data.history.length === 0) return;
    // 让可能还挂着的那个「失焦收起」定时器作废（原因见 onSearchBlur）
    this._panelToken = (this._panelToken || 0) + 1;
    this.setData({ historyVisible: true });
  },

  // 输入框失焦 → 收起面板
  //
  // 【为什么要延迟 250ms】
  //   点历史标签时，输入框会先失焦、再触发标签的 tap。
  //   失焦就立刻把它从 DOM 里摘掉的话，那一下 tap 就落在了半路上 ——
  //   元素已经没了，用户点了历史什么都没发生，还会以为标签是死的。
  //   等 250ms，让 tag 的 tap 先走完。
  //
  // 但「收起」本身是幂等的，所以这里不去记 timer id 取消它 ——
  // 标签那条路收起一次、250ms 后这里再收起一次，结果完全相同。
  //
  // 真正要防的是【另一种】次序：点遮罩收起 → 立刻又点搜索框。
  // 第二次点击会把面板重新打开，可第一个点击留下的这个定时器
  // 还在路上，250ms 后照样把刚打开的面板缩回去 ——
  // 用户看到的是「点了弹出来、眨一下就没了」。
  // 用一个只会自增的 token 判一下：这 250ms 里没人重新打开过，才收起。
  onSearchBlur() {
    const token = this._panelToken || 0;
    setTimeout(() => {
      if (this._panelToken !== token) return;
      this.setData({ historyVisible: false });
    }, 250);
  },

  // 点遮罩收起
  onHideHistory() {
    this.setData({ historyVisible: false });
  },

  // 回车 / 点键盘「搜索」
  //
  // van-search 的 search 事件里 e.detail 【就是输入值本身（字符串）】，
  // 不是 { value: ... }。这一点抄错了就是「点了没反应」——
  // 已核对 miniprogram_npm/@vant/weapp/search/index.js 里的
  // $emit('search', event.detail)，event.detail 来自 input 的原生事件。
  onSearch(e) {
    const keyword = String(e.detail || '').trim();

    if (!keyword) {
      wx.showToast({ title: '请输入搜索关键词', icon: 'none' });
      return;
    }
    // 按下搜索 = 要看结果，历史面板让位。
    // 放在下面那道「同词拦截」【之前】：被拦掉的那次虽然不重查，
    // 但用户的心意一样是「我要看结果」—— 面板赖着不走就成了挡路的。
    this.setData({ historyVisible: false });

    // 同一个词重复搜没意义，还白白多打一次数据库
    if (keyword === this.data.keyword && this.data.searched) return;

    this.setData({ keyword, inputValue: keyword });
    // 记历史放在上面那道拦截【之后】：被拦掉的那次根本没查，
    // 不该算一次「搜过的词」。
    this.recordHistory(keyword);
    this.loadGoodsList(true);
  },

  // 点历史记录：用这个词再搜一次
  //
  // 【这里为什么不复用 onSearch】
  //   onSearch 开头有一道「同一个词 + 已经搜过 → 直接 return」。
  //   而「搜了没结果」那个状态下，历史里的那个词恰恰【就是】当前关键词 ——
  //   复用的话用户点了半天界面一动不动，只会以为历史记录是坏的。
  //   所以这里不走拦截、直接重查，顺手把列表清空回到「搜索中」，
  //   让这一下点击立刻有反馈。
  onHistoryTap(e) {
    const keyword = String(e.currentTarget.dataset.kw || '').trim();
    if (!keyword) return;

    // 上一次搜索还在路上时直接忽略这一下：
    // loadGoodsList 见到 loading 会立刻返回，可上面已经把列表清空了 ——
    // 那样页面会卡在「搜索中」，等一个回来就往旧关键词那份结果里写的响应。
    if (this.data.loading) return;

    this.setData({
      keyword,
      inputValue: keyword,
      goodsList: [],
      page: 0,
      isEnd: false,
      searched: false,
      historyVisible: false
    });
    this.recordHistory(keyword);
    this.loadGoodsList(true);
  },

  // 删掉一条历史
  //
  // catchtap 而不是 bindtap：这个标签自身是 bindtap="onHistoryTap"，
  // 不拦住冒泡的话，点 × 会先删掉、紧接着又拿这个词搜一次 ——
  // 用户想删，结果搜出来了，还以为根本没删掉。
  onRemoveHistory(e) {
    const keyword = String(e.currentTarget.dataset.kw || '');
    const history = this.data.history.filter((k) => k !== keyword);
    this.setData({ history });
    writeHistory(history);
  },

  // 清空全部历史
  //
  // 加一道确认：历史是本地唯一「攒出来的」数据，误触一下就全没了，
  // 而且没法恢复 —— 服务端没有副本，这正是「只存本地」的代价。
  // 项目里取消订单、撤销卖出这些不可逆操作都走 showModal，这里跟着来。
  onClearHistory() {
    wx.showModal({
      title: '清空搜索历史',
      content: '清空后无法恢复，确定清空吗？',
      confirmText: '清空',
      confirmColor: '#FF9500',
      success: (res) => {
        if (!res.confirm) return;
        // 顺手收起面板：历史清空了，面板的 wx:if 本来就会失效，
        // 但 historyVisible 还留在 true —— 下一个搜的词一进历史，
        // 面板会莫名其妙自己弹出来盖住刚搜到的结果。
        this.setData({ history: [], historyVisible: false });
        writeHistory([]);
      }
    });
  },

  // 点输入框里的 × 清空
  onClear() {
    // 结果一起清掉。只清输入框、留着上次结果的话，
    // 页面会处在一个「输入框空的、下面却列着一堆商品」的状态，
    // 用户看不懂这堆东西是按什么筛出来的
    //
    // historyVisible 置 true：清空这个动作的意思就是「我要换个词」，
    // 此刻最该看到的就是搜过什么。它同时也兜住一个死角 ——
    // 从首页带词进来时输入框从没聚焦过，光靠 focus 事件
    // 是弹不出面板的，而 × 一定点得到。
    this.setData({
      keyword: '',
      inputValue: '',
      goodsList: [],
      page: 0,
      isEnd: false,
      searched: false,
      historyVisible: true
    });
  },

  // 查询商品列表（reset 为 true 时从头加载）
  // 只读公开数据，直连数据库，不走云函数 —— 和首页、分类页一致
  loadGoodsList(reset) {
    if (this.data.loading) return Promise.resolve();
    if (!reset && this.data.isEnd) return Promise.resolve();

    const keyword = this.data.keyword;
    if (!keyword) return Promise.resolve();

    this.setData({ loading: true });
    const page = reset ? 0 : this.data.page;

    const db = wx.cloud.database();
    const _ = db.command;
    const reg = db.RegExp({ regexp: escapeRegExp(keyword), options: 'i' });

    // 标题和描述都搜。
    //
    // 为什么用 _.or：写成 where({ title: reg, description: reg }) 是
    // 【并且】—— 要求标题和描述同时命中同一个词，那几乎什么都搜不到。
    // 一个 where 对象里的多个字段默认是 AND，这个顺手就写错了。
    //
    // 为什么 status 在每个分支里都写一遍：_.or 数组里的每一项都是一个
    // 独立的完整条件，不是「在共同条件之上再 or」。漏写一边的后果很隐蔽 ——
    // 那一半结果会把已售出、已下架的旧商品也捞出来。
    // （也不能只在外面写 status，那和 _.or 是 AND 关系，写在外层是可行的，
    //   但两种写法混着用容易看漏，统一放分支里更好核对。）
    const where = _.or([
      { status: GOODS_STATUS.ON_SALE, title: reg },
      { status: GOODS_STATUS.ON_SALE, description: reg }
    ]);

    return db
      .collection(COLLECTION.GOODS)
      .where(where)
      .orderBy('createTime', 'desc')
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
          publisher: item.publisher || { avatar: '', nickname: '校园用户' },
          // 高亮切片，null = 标题里没这个词（命中的是描述）
          hl: splitByKeyword(item.title, keyword)
        }));

        this.setData({
          goodsList: reset ? list : this.data.goodsList.concat(list),
          page: page + 1,
          isEnd: list.length < PAGE_SIZE,
          loading: false,
          searched: true
        });
      })
      .catch((err) => {
        console.error('搜索失败：', err);
        this.setData({ loading: false, searched: true });
        wx.showToast({ title: '搜索失败，请重试', icon: 'none' });
      });
  },

  // 点击商品
  // 点击商品卡片。id 来自 goods-card 组件的 cardtap 事件（e.detail.id），
  // 不是 dataset —— 组件已经不用 data-id 了
  onGoodsTap(e) {
    const { id } = e.detail;
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` });
  },

  // 从详情页下单回来时，刚买的那件不该再出现在结果里。
  //
  // ⚠️ 必须先判 keyword —— 刚进这一页、还没搜过的时候 keyword 是空的，
  //    loadGoodsList 里那道 `if (!keyword) return` 会兜住，
  //    但这里先判一下更清楚，也省掉一次无谓的调用。
  //    而且这时候【不能】消费标记：用户还没搜过，标记留着给首页用。
  onShow() {
    // 历史重新读一次。搜索页会一直留在页面栈里，中间用户可能去过
    // 「我的 → 设置 → 清除缓存」（wx.clearStorageSync 会把历史一起清掉），
    // 这时候 data 里那份就成了幽灵 —— 界面上还列着，点下去却什么都搜不到。
    this.setData({ history: readHistory() });

    if (!this.data.keyword) return;
    if (consumeGoodsChanged()) {
      this.loadGoodsList(true);
    }
  },

  onPullDownRefresh() {
    this.loadGoodsList(true).then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    this.loadGoodsList(false);
  },

  onShareAppMessage() {}
});
