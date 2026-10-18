// utils/cloud-config.js
// 云开发相关常量集中配置

// ============================================================
// 【配置区 · 第 1 块】品牌信息
// ============================================================
//
// 品牌在这里一处替换。前提是各页面【不许】再直接写死「物校角」
// 「湖南科技学院」—— 那样换学校得做全局查找替换，漏掉一处就会
// 在界面上露出别的名字，而这类错误在上线前几乎不会被发现
// （没人会去点「关于」页）。
//
// ⚠️ 有两处【改不了】，因为它们是 JSON 字面量，不能引用变量：
//     app.json              → navigationBarTitleText
//     pages/home/home.json  → navigationBarTitleText
//     这两处必须手工改，README 的「配置清单」里列了。
//
// ⚠️ 云函数 require 不到这个文件（云函数独立打包，只上传自己的目录），
//     所以云函数侧的配置在各自的 index.js 顶部：
//       cloudfunctions/user/index.js  → SCHOOL_LAT / SCHOOL_LNG
//       cloudfunctions/order/index.js → DEFAULT_ADMIN_OPENIDS
//     两边要一起改。搜索【配置区】能同时找到所有位置。
const BRAND = {
  // 小程序名称。首页/我的/关于/隐私说明里的品牌名都用它。
  APP_NAME: '物校角',

  // 学校全称。注册页、关于页、隐私说明这些需要正式表述的地方用它。
  // ⚠️ 它不只是文案：真正判定「在不在校内」的坐标在
  //    cloudfunctions/user/index.js 的 SCHOOL_LAT / SCHOOL_LNG，
  //    换学校的时候两处必须一起改，否则会出现
  //    「页面上写着 A 校，实际按 B 校的坐标核验」。
  SCHOOL_NAME: '湖南科技学院'
};

// 云开发环境 ID
// 获取方式：微信开发者工具 → 云开发 → 设置 → 环境设置 → 复制「环境 ID」
// 形如 cloud1-xxxxxxxxxxxxxxx。
//
// ⚠️ 换成你自己的。仓库里留的是占位符，不是任何真实环境 ——
//    环境 ID 本身不算密钥，但它会把请求指向别人的环境，
//    表现是「云调用全部失败」，却看不出是配置问题。
const ENV_ID = 'YOUR_ENV_ID';

// 数据库集合名
const COLLECTION = {
  GOODS: 'goods', // 商品
  USERS: 'users', // 用户档案
  ADDRESS: 'address', // 收货地址
  FAVORITES: 'favorites', // 收藏
  ORDERS: 'orders', // 订单
  NOTIFICATIONS: 'notifications', // 站内通知（订单状态变化时写入，见 cloudfunctions/order）
  // 意见反馈。⚠️ 必须和 cloudfunctions/feedback/index.js 里的 FEEDBACK 一致！
  // 搜索 FEEDBACK 能同时找到这两个地方。
  FEEDBACK: 'feedback'
};

// 云存储目录前缀
const CLOUD_PATH = {
  // 商品图片。
  //
  // 完整路径是：goods/<上传者的 openid>/<时间戳-随机数>.<后缀>
  // 多出的 openid 一层是安全边界：manageGoods.remove 删文件时
  // 用 getWXContext 的 OPENID 重算前缀，只删调用者自己目录下的图。
  // 只判 goods/ 的话，拿到别人的 fileID 就能让服务端把别人的商品图删掉。
  // 必须和 cloudfunctions/publishGoods、manageGoods 里的 GOODS_IMAGE_PREFIX 一致。
  // 搜索 GOODS_IMAGE 能同时找到这三处。
  GOODS_IMAGE: 'goods/',
  AVATAR: 'avatar/', // 用户头像
  // 聊天图片。单独一个目录，不跟商品图混在一起 ——
  // 云函数的 sendMessage 会把消息内容限定成「必须是 chat/ 开头」的 fileID，
  // 见 cloudfunctions/chat/index.js 的 validChatImageFile。
  // 两处前缀必须一致，搜索 CHAT_IMAGE 能同时找到这两个地方。
  CHAT_IMAGE: 'chat/',
  // 反馈截图。
  //
  // ⚠️ 必须和 cloudfunctions/feedback/index.js 里的 FEEDBACK_IMAGE 一致！
  //    搜索 FEEDBACK_IMAGE 能同时找到这两个地方。
  //
  // 【这个前缀后面还要再拼一层 openid】完整路径是：
  //     feedback/<上传者的 openid>/<时间戳-随机数>.<后缀>
  // 多出的那一层不是整理用的，是【安全边界】：
  // 服务端要能独立判断「这张图是不是调用者自己的」，才敢删它。
  // 只判 feedback/ 前缀是不够的 —— 那样拿到别人的 fileID 就能让服务端把
  // 别人的图删掉（删除不可逆）。云函数那边会用 getWXContext 的 OPENID
  // 重算这个前缀来比，绝不信客户端传上来的值。
  // 详细理由见 cloudfunctions/feedback/index.js 的 validFeedbackImage。
  FEEDBACK_IMAGE: 'feedback/'
};

// 默认头像：用户没有设置头像时显示的那张图
//
// 放在公共常量里而不是各页面自己写一份：头像为空是【每个】显示头像的地方
// 都会遇到的情况（现在「我的」和「编辑」两处要用），将来想换一张默认图，
// 改这一行就够。
//
// ⚠️ 用法是【渲染时兜底】，不是填进数据。WXML 里这么写：
//      <image src="{{userInfo.avatar || defaultAvatar}}" />
//
//    绝不能写成 data 里的 avatar: user.avatar || DEFAULT_AVATAR。
//    原因见 pages/edit/edit.js 的 uploadAvatar：它把「既不是 cloud://
//    也不是 https://」的路径统统当成「用户刚选的本地图片」上传到云存储。
//    而 /images/default-avatar.png 正好落在这个区间里 —— 于是每个没设头像的
//    用户点一次保存，就往云存储塞一份默认图的副本，他的 avatar 也被写成
//    那个副本的 fileID，从此再也不是「在用默认头像」了。
//    全程不报错，图上还是那张默认图，最难查。
const DEFAULT_AVATAR = '/images/default-avatar.png';

// 客服邮箱（唯一公开的联系方式）
//
// 【为什么只剩这一个字段】
//   这里原来叫 SERVICE_CONTACT，三个字段（电话 / 微信号 / 邮箱），
//   对应客服页上那一整块「联系方式」列表。
//     2026-10-14：产品要求删掉那一块 → 三个字段全成了死配置。
//     2026-10-15：又要求把邮箱加回页面上当退路 → 只恢复了邮箱。
//
//   ⚠️【故意不再保留 phone / wechat 两个空字段】——
//     一个「填了没反应」的配置项，比没有这个配置项更难查：
//     下一个人会以为自己填错了地方。要加电话就现加，别提前占位。
//
// 【为什么需要它：客服按钮是单点故障】
//   客服页上那个 open-type="contact" 按钮，在公众平台【没开通客服功能】
//   或者【没绑客服人员】时，点下去是一点反应都没有的 ——
//   不报错、不弹窗、bindcontact 回调也不触发。
//   页面里再没有别的东西的话，用户就彻底找不到人了。
//   所以下面这行邮箱【不是装饰，是那条退路】。别顺手把它删了。
//
// 【它同时还是后台《用户隐私保护指引》第 4 节的联系方式】
//   指引里承诺「可通过以下方式与开发者联系，行使查阅、复制、更正、
//   删除等法定权利」以及「申请注销账号」，给的就是这个邮箱。
//   ⚠️ 两边必须是【同一个邮箱】。改这里要同步改后台那份，否则又是一处对不上。
//
// 【换邮箱时的硬规矩：必须是国内能正常打开的服务（QQ / 163 之类）】
//   gmail 在境内无法直接访问 —— 用户看到页面上这行字、想发邮件，
//   打开是白屏，而界面上完全看不出问题。所以别用 gmail。
//   ⚠️ 换的时候【两处一起换】：这里，加上后台《用户隐私保护指引》第 4 节。
const SERVICE_EMAIL = 'your-email@example.com';

// 商品状态
//
// 这是商品的「一生」，一次只能处在一个状态：
//
//   on_sale ──买家下单──→ locked ──卖家确认──→ sold
//      ↑                    │
//      └──取消/拒绝/卖家直接卖出──┘
//
// locked 是锁单机制的核心：一件商品被某个买家下单后立刻变成 locked，
// 对其他人就「消失」了（首页只查 on_sale）。回到 on_sale 的唯一途径
// 是那笔订单被关掉（买家取消 / 卖家拒绝 / 卖家直接卖出）。
const GOODS_STATUS = {
  ON_SALE: 'on_sale', // 出售中
  LOCKED: 'locked', // 已被买家下单，等待卖家确认
  OFF_SALE: 'off_sale', // 已下架
  SOLD: 'sold' // 已卖出
};

// 商品状态对应的中文标签
const GOODS_STATUS_TEXT = {
  on_sale: '在售',
  locked: '已被预订',
  off_sale: '已下架',
  sold: '已售出'
};

// 订单状态
//
//   pending ──卖家确认──→ completed   （终态）
//      │
//      └──买家取消 / 卖家拒绝 / 卖家直接卖出──→ cancelled   （终态）
//
// completed 和 cancelled 都是终态，不能再变。云函数里每个操作都要先校验
// 当前状态，否则会出现「已完成的订单被取消」这种自相矛盾的数据。
const ORDER_STATUS = {
  PENDING: 'pending', // 待卖家确认
  COMPLETED: 'completed', // 已完成
  CANCELLED: 'cancelled' // 已关闭
};

const ORDER_STATUS_TEXT = {
  pending: '待卖家确认',
  completed: '交易完成',
  cancelled: '已关闭'
};

// ============================================================
// 配送
// ============================================================
//
// ⚠️ DELIVERY_FEE 必须和 cloudfunctions/order/index.js 里的同名常量一致！
//    云函数独立部署、require 不到这个文件，只能两处各写一份。
//    搜索 DELIVERY_FEE 能同时找到这两个地方。
//
//    前端这份只用来【显示】—— 下单页报给买家要付多少，配送管理页显示
//    每单能赚多少。真正算钱、真正写进订单的是云函数那份，前端改错了
//    影响不了实际收多少。这是「前端管显示、后端管裁决」的老规矩。
//
// ⚠️ 特别注意：订单里的 delivery.fee 是【下单那一刻冻结的价格】，
//    不是拿这张表现算的。以后改这张表，老单子显示的仍是老价格 ——
//    这是对的。所以任何地方显示【某一单】的费用，都要读 order.delivery.fee，
//    绝不能拿 DELIVERY_FEE[order.delivery.size] 现算。
const DELIVERY_SIZE = {
  SMALL: 'small',
  LARGE: 'large'
};

// ⚠️ 这两个词现在【不要拿去给用户看】。
//
// 档位改成由商品单价定之后，「大件」指的是「价格超过 200」，
// 跟体积没有任何关系了 —— 一件 ¥250 的教材会被标成「大件」，
// 而一个 ¥199 的行李箱是「小件」。买家看到这种标签只会更糊涂。
//
// 目前全项目已经没有任何地方在用它（原来是配送中心卡片上的状态标签，
// 已随改判功能一起删掉）。留着是为了不要把配置项删得不留痕迹；
// 真要恢复使用，先想清楚标签上该写什么词。
const DELIVERY_SIZE_TEXT = {
  small: '小件',
  large: '大件'
};

const DELIVERY_FEE = {
  small: 1,
  large: 2
};

// 大件的分界线：商品单价【高于】这个数算大件，否则小件。
//
// ⚠️ 必须和 cloudfunctions/order/index.js 里的同名常量一致！
//    搜索 DELIVERY_LARGE_PRICE 能同时找到这两个地方。
//
// 【前端为什么也要复制一份这个判断】
//    下单页要在【订单还不存在】的时候就把金额报给买家 —— 那时候没有
//    任何订单字段可读，算不出来就只能说「由配送员定」，而那正是这套
//    规则要消灭的说法。所以这里必须自己算一遍。
//    代价是：这里算错了，买家看到的数和实际收的数就会对不上。
//    改这个数的时候，两个地方一起改。
const DELIVERY_LARGE_PRICE = 200;

// 按商品单价定档。和云函数里的 sizeByPrice 是同一个判断。
//
// ⚠️ 边界（恰好 200 算小件，「高于」才是大件）必须和云函数一致 ——
//    一边含等号一边不含，就会出现「下单页说 ¥1、订单里记 ¥2」。
function deliverySizeByPrice(price) {
  const n = Number(price);
  return Number.isFinite(n) && n > DELIVERY_LARGE_PRICE
    ? DELIVERY_SIZE.LARGE
    : DELIVERY_SIZE.SMALL;
}

// 某件商品该收多少配送费。下单页显示金额用这一个就够，
// 不要在外面自己拼 sizeByPrice + DELIVERY_FEE —— 多一处拼接就多一处漏改。
function deliveryFeeOf(price) {
  return DELIVERY_FEE[deliverySizeByPrice(price)];
}

// 配送单状态：待接单 → 配送中 → 已送达
const DELIVERY_STATUS = {
  WAITING: 'waiting',
  ACCEPTED: 'accepted',
  DELIVERED: 'delivered'
};

const DELIVERY_STATUS_TEXT = {
  waiting: '待接单',
  accepted: '配送中',
  delivered: '已送达'
};

// ============================================================
// 订阅消息模板 ID
// ============================================================
//
// ⚠️ 必须和 cloudfunctions/order/index.js 里的 TPL_NEW_ORDER / TPL_ORDER_STATUS 一致！
//    云函数是独立部署的，require 不到这个文件，只能两处各写一份。
//    搜索 TPL_NEW_ORDER 能同时找到这两个地方。
//
// 前端为什么也要：wx.requestSubscribeMessage 得指定「订阅哪几个模板」，
// 微信不会让你订阅一个不存在的 ID —— 抄错了会静默失败（弹窗都不出来）。
//
// 抄这串字符时留意同形异码：I（大写 i）/ l（小写 L）/ 1（数字一）
// 在很多字体里长得一模一样。这个项目为同一个坑栽过一次。
const SUBSCRIBE_TEMPLATE = {
  // 卖家收：有人下单了。在「我卖出的」页面请求
  NEW_ORDER: 'YOUR_NEW_ORDER_TEMPLATE_ID',
  // 买家收：订单走到终态了。在「我买到的」页面请求
  ORDER_STATUS: 'YOUR_ORDER_STATUS_TEMPLATE_ID'
};

// ============================================================
// 售价上限
// ============================================================
//
// ⚠️ 必须和 cloudfunctions/publishGoods/index.js、cloudfunctions/manageGoods/index.js
//    里的同名常量一致！搜索 PRICE_MAX 能同时找到这三个地方。
//
// 【为什么需要】
//    原来的校验只有「非空且大于 0」（push.js 的 if (!price)、云函数的 if (price <= 0)），
//    没有任何上限。用户在数字键盘上连按 25 个 9 是完全做得到的，
//    Number('999…9') 得到 1e25，存进库是合法的双精度浮点数，
//    渲染时隐式 String() 就成了 ¥1e+25 —— 首页、详情页、列表全都是科学计数法。
//    加个上限，这个数从此进不来。
//
// 【9999 是怎么定的】
//    校园二手的真实价格带：教材几块、日用几十、自行车几百、笔记本几千。
//    四位数封顶够用，同时把「手滑多按几个 9」挡在外面。
//    如果以后真有人要卖更贵的东西，改这一个数（以及上面那两个云函数）就行。
//
// 【它还顺便解决了一个安全问题】
//    库里已经存在两条这种脏数据。除了阻止新的进来，
//    cloudfunctions/order/index.js 的 createOrder 里也用这个上限做了一道判断：
//    超出上限的商品【不能下单】。这样脏数据不用手动去数据库改，
//    它自己就变成买不了的东西了。
const PRICE_MAX = 9999;

// 售价最多保留的小数位。二手交易里 ¥12.5 是合理的，
// 但 ¥12.3456789 只说明用户没想清楚，存进去还会让后续所有金额计算变脏。
const PRICE_DECIMALS = 2;

// 用户档案里「昵称」和「真实姓名」的长度上限。
//
// ⚠️ 必须和 cloudfunctions/user/index.js 里的 NICKNAME_MAX / REAL_NAME_MAX 一致！
//    云函数独立部署、require 不到这个文件，只能两处各写一份。
//    搜索 REAL_NAME_MAX 能同时找到这两个地方。
//
// 前端这份【只用来做体验层的长度提示】，真正裁决的是云函数那份。
const NICKNAME_MAX = 20;
const REAL_NAME_MAX = 20;

// 【学校坐标 / 核验半径 —— 已从这里删除，2026-10-14】
//
// 原来这里放着 SCHOOL_LAT / SCHOOL_LNG / ALLOW_RADIUS_M 三个常量，
// 注释还说「主包编译时会引用，删掉会 app.js 起不来」。
// 那句话是不对的 —— 真正会导致 ReferenceError 的是
// 「删了上面的声明、却留着下面 module.exports 里的导出」，
// 删干净（声明 + 导出）没有任何问题。当时的注释把症状描述对了，
// 却把原因认错了，于是这三个常量就一直在包里没人敢动。
//
// 为什么要删：
//   1. 【没人用】。距离核验整个搬到了 user 云函数，
//      全项目搜 ALLOW_RADIUS_M 只剩这几行自己。
//   2. 【留在包里是泄漏】。pages/register/register.js 里那段注释
//      自己写着「学校坐标写在 utils/cloud-config.js，反编译就能拿到
//      填哪一对数字能过核验」—— 然后把坐标搬走了，却没删掉这一份。
//   3. 【会过期说谎】。两边各存一份半径，云函数那边一调（3000 → 10000），
//      这里就变成一条错误的线索，下次排查的人会先被它带偏。
//
// 位置核验的唯一真相在 cloudfunctions/user/index.js。
// 搜索 ALLOW_RADIUS_M 现在只会命中那一处。

// 首页列表每页条数
const PAGE_SIZE = 10;

// ============================================================
// 【开发期开关】允许购买 / 收藏自己发布的商品
// ============================================================
//
// ⚠️ 必须和 cloudfunctions/order/index.js 里的 DEV_ALLOW_SELF_BUY 保持一致！
//    云函数是独立部署的，require 不到这个文件，所以只能两处各写一份。
//    搜索 DEV_ALLOW_SELF_BUY 能同时找到这两个地方。
//
// 为什么需要：开发阶段只有一个微信号，正常交易里「不能买自己的东西」这个
// 限制是对的，但不放开就完全没法测「下单 → 卖家确认 → 我买到的」这条主流程。
//
// 这个开关【只决定前端显不显示按钮】，真正放不放行是云函数说了算。
// 两边万一忘了同步也不会出事：最坏就是点下去被服务端拒绝、弹个提示，
// 不会写出脏数据。前端管显示、后端管裁决 —— 这个分工不要反过来。
//
// 【已于 2026-09-21 关闭】双账号买卖流程测试通过，不再需要这个口子了。
// 关掉之后前端会恢复成正常形态：自己的商品只显示「管理我发布的商品」。
const DEV_ALLOW_SELF_BUY = false;

// ============================================================
// 意见反馈
// ============================================================
//
// ⚠️ 这一整段都必须和 cloudfunctions/feedback/index.js 里的同名常量一致！
//    云函数独立部署、require 不到这个文件，只能两处各写一份。
//    搜索 FEEDBACK_TYPE / FEEDBACK_STATUS / FEEDBACK_IMAGE_MAX /
//    FEEDBACK_CONTENT_MAX / FEEDBACK_DAILY_MAX 能同时找到这两个地方。
//
// 前端这份只用来【显示和提前拦一下】—— 选什么类型、最多几张图、
// 描述能写多长。真正裁决的是云函数那份。前端改错了影响不了实际存什么，
// 但会让用户填完才被服务端打回，所以两边还是得一起改。

// 反馈类型。
//
// ⚠️ 值（feature/bug/trade/other）是【存进库的】，不要改 ——
//    库里已有的记录用的就是这些字符串。要加类型可以往后加，
//    但不要动已有的值。中文文案随便改，那只影响显示。
const FEEDBACK_TYPE = {
  FEATURE: 'feature',
  BUG: 'bug',
  TRADE: 'trade',
  OTHER: 'other'
};

const FEEDBACK_TYPE_TEXT = {
  feature: '功能建议',
  bug: 'BUG反馈',
  trade: '交易问题',
  other: '其他问题'
};

// 处理状态。
//
// ⚠️【前端只认精确的 'done'】，其余一切值都当「处理中」。
//
//   为什么这么写：状态是管理员在云开发控制台里手改的（这个项目没有
//   小程序内的管理页）。手改就会打错 —— 打成 'Done'、'已处理'、
//   'resolved'、或者前后带个空格。
//   如果反过来写成「不是 pending 就算已处理」，那么任何一个打错的字
//   都会让【没处理】的反馈在用户眼里变成【已处理】—— 用户以为有人管了，
//   于是不再追问，这条反馈就真死了。那是功能撒谎，是这个页面从第一天起
//   就在避免的事。
//   按现在这个写法，打错字最坏的结果是「处理了但显示处理中」——
//   用户多等，但不会误以为已经有人回应过他。
//   宁保守，不撒谎。
const FEEDBACK_STATUS = {
  PENDING: 'pending',
  DONE: 'done'
};

const FEEDBACK_STATUS_TEXT = {
  pending: '处理中',
  done: '已处理'
};

// 一次最多传几张截图、描述最多多少字。
//
// ⚠️ FEEDBACK_IMAGE_MAX 和 FEEDBACK_CONTENT_MAX 这两个数字全项目各有【三处】：
//      utils/cloud-config.js（这里）        ← 常量本身
//      cloudfunctions/feedback/index.js     ← 常量本身（独立部署，各写一份）
//      pages/privacy/privacy.wxml           ← 用中文写着「最多 500 字 / 最多 3 张」
//    改的时候三处一起改。前两处 grep FEEDBACK_IMAGE_MAX 就找到了，
//    第三处搜不到常量名，只能靠知道有这个地方 —— 所以它列在这里。
//
//    【pages/suggest/suggest.wxml 不在这张单子里】—— 它虽然也要用这两个数，
//    但不是抄的：suggest.js 把 imageMax / contentMax 放进了 data，
//    模板里读的是 {{imageMax}} / {{contentMax}}。
//    （最开始是把 3 和 500 硬写进 WXML，于是变成「四处」，
//      而且 WXML 那处 grep FEEDBACK_IMAGE_MAX 搜不到，是这张单子上
//      最容易漏的一处。让它读 data 就把这一处整个消掉了。）
const FEEDBACK_IMAGE_MAX = 3;
const FEEDBACK_CONTENT_MAX = 500;

// 同一用户 24 小时内最多提交几条。
//
// ⚠️ 必须和 cloudfunctions/feedback/index.js 里的同名常量一致！
//    搜索 FEEDBACK_DAILY_MAX 能同时找到这两个地方。
//
// 前端【不用】这个数做任何判断 —— 它是纯服务端防线，列在这里只是
// 为了让「反馈有哪些规则」这件事在一个文件里看得全。前端硬编码一个
// 「今天还能提交几条」只会多一份会过期的副本。
//
// 10 这个值定得很宽：正常学生报一个 bug 根本碰不到。它挡的是脚本刷 ——
// 反馈是唯一能一次往云存储塞 3 张图、又完全不受交易流程约束的入口。
const FEEDBACK_DAILY_MAX = 10;

module.exports = {
  // 【配置区】品牌名与学校名。见文件顶部的说明。
  BRAND,
  ENV_ID,
  COLLECTION,
  CLOUD_PATH,
  DEFAULT_AVATAR,
  // 客服邮箱。见上方 SERVICE_EMAIL 的说明（含「为什么不能删」和「待换」）。
  SERVICE_EMAIL,
  GOODS_STATUS,
  GOODS_STATUS_TEXT,
  ORDER_STATUS,
  ORDER_STATUS_TEXT,
  SUBSCRIBE_TEMPLATE,
  PRICE_MAX,
  PRICE_DECIMALS,
  NICKNAME_MAX,
  REAL_NAME_MAX,
  PAGE_SIZE,
  DEV_ALLOW_SELF_BUY,
  DELIVERY_SIZE,
  DELIVERY_SIZE_TEXT,
  DELIVERY_FEE,
  DELIVERY_LARGE_PRICE,
  deliverySizeByPrice,
  deliveryFeeOf,
  DELIVERY_STATUS,
  DELIVERY_STATUS_TEXT,
  FEEDBACK_TYPE,
  FEEDBACK_TYPE_TEXT,
  FEEDBACK_STATUS,
  FEEDBACK_STATUS_TEXT,
  FEEDBACK_IMAGE_MAX,
  FEEDBACK_CONTENT_MAX,
  FEEDBACK_DAILY_MAX
};
