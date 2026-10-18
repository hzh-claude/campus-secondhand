// cloudfunctions/order/index.js
// 订单：买家下单 / 我买到的 / 我收到的 / 卖家确认 / 关闭订单
//
// 数据模型：orders 集合，一条记录 = 一次交易意向
//   {
//     _openid,          买家
//     sellerOpenid,     卖家（冗余，见下）
//     goodsId,
//     goods:  { title, price, image, campus },   ← 下单那一刻的商品快照
//     buyer:  { nickname, avatar },
//     seller: { nickname, avatar },
//     status, cancelReason, createTime, finishTime
//   }
//
// 为什么 sellerOpenid 是冗余的？
//   不冗余的话，「我收到的订单」得先查我的所有商品、再按商品 id 反查订单，
//   两次查询而且商品多了没法做。存一份就能直接 where({sellerOpenid}) 查出来。
//   这是「为查询而冗余」——和 goods 里存 publisher 快照是同一个套路。
//
// 为什么存商品快照而不是只存 goodsId？
//   商品会被改价、被删除。订单是【历史凭证】：
//   「我当时看到的是一口价 ¥99」必须永远成立，不能被后来的修改影响。
//
// ============================================================
// 配送（下单选了「配送」的订单才有这个子文档）
// ============================================================
//
//   delivery: {
//     status: 'waiting' | 'accepted' | 'delivered',
//     size:   'small' | 'large',                  ← 下单时按商品单价算好（sizeByPrice）
//     fee:    1 | 2,                              ← 和 size 同时【冻结】，之后不再变
//     courierOpenid: '',                          ← 谁接的这单
//     address: { name, phone, campus, detail },   ← 下单那刻的地址快照
//     sellerPhone: '',                            ← 卖家确认订单时留的取货电话
//     acceptTime: null, deliverTime: null
//   }
//
// 为什么取货电话是卖家在【确认订单】时才给，不是发布商品时就填？
//   发布时填的话，一个卖家发十件东西要填十遍，而且大部分单子
//   根本不会走配送。放在确认那一刻问，只在真正要送的时候问一次，
//   问完还会存回用户资料 —— 一个人一辈子只被问一次。
//
// 为什么配送信息挂在订单上，而不是单独开一个 deliveries 集合？
//   配送不可能独立于订单存在 —— 订单黄了，配送也就没了。
//   分成两个集合就要维护一致性（订单关闭时去删配送单），
//   而一致性维护【永远会漏掉某条路径】。放一起，它天然就一致。
//
// 为什么 address 存快照？
//   和 goods 快照同一个道理：买家后来改了地址、删了地址，
//   这一单的送货地址不能跟着变，否则配送员按新地址送，
//   送到一个买家当时根本没填过的地方。
//
// 为什么 fee 存下来，不是每次现算？
//   以后把小件涨到 3 元，老单子上显示的必须还是 1 元。
//   这就是「历史凭证」的全部含义。
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const ORDERS = 'orders';
const GOODS = 'goods';
const USERS = 'users';
const ADDRESS = 'address';

// 售价上限。
//
// ⚠️ 必须和 utils/cloud-config.js、cloudfunctions/publishGoods/index.js、
//    cloudfunctions/manageGoods/index.js 里的同名常量一致！
//    搜索 PRICE_MAX 能找到全部四处。
//
// 这里用它做下单前的最后一道判断：超出上限的商品【不能买】。
// 详细理由见 create() 里那段注释。
const PRICE_MAX = 9999;

// 部署版本号：每次改动 +1。
// 云函数没部署成功时不会明说，版本号能让它自己招供。
// 部署后在云开发控制台测试 {"action":"whoami"}，
// 应当看到 version: 13 和当前的 adminCount。
const CODE_VERSION = 13;

// 定时触发器名称。
//
// ⚠️ 必须和 order/config.json 里 triggers[0].name 一致！
//    平台在触发时会把这个名字塞进 event.TriggerName，对不上就说明
//    这次调用不是定时器发出来的。搜索 autoCloseExpiredOrders 能同时找到两处。
const TIMER_TRIGGER_NAME = 'autoCloseExpiredOrders';

// 【V-02 修复】是否允许「非平台来源」手动触发定时任务分支。生产环境必须 false。
//
// 【为什么必须有这个开关，且默认 false】
//   旧代码只判 event.Type === 'Timer' 就放行，而 Type 是客户端可以
//   随便构造的 data 字段 —— 任意用户执行
//     callFunction({ name:'order', data:{ Type:'Timer' } })
//   就能以管理员权限触发一次全量订单超时清理，没有登录态校验、
//   没有身份校验，还能反复调用。
//
//   现在放行条件改成「没有 OPENID（定时触发没有登录态）+ TriggerName
//   与平台注入的值一致」——这两条客户端都造不出来（他造得出 Type，
//   但造不出「同时让 OPENID 为空」）。
//
//   这个开关只为本地调试保留（开发者工具里手动触发拿不到平台环境，
//   只能自己造 event）。默认关闭意味着要开必须改代码 + 重新部署，
//   而不是改个请求参数就能开 —— 配错的默认值必须往「什么都不给」的方向倒。
const ALLOW_MANUAL_TIMER = false;

// ============================================================
// 锁单超时：多久没处理就自动放回货架
// ============================================================
//
// 为什么必须有这个？
//   锁单解决的是「一件商品被多人同时下单」，但它带来了一个新问题：
//   商品被锁住之后，只有【人】能解开（买家取消 / 卖家拒绝 / 卖家直接卖出）。
//   如果买家下完单就不管了，卖家又不常打开小程序，商品就无限期挂着 ——
//   明明还在、谁都买不了。
//
//   靠「总有人会去点一下」是不成立的假设。必须有个不需要任何人参与的出口。
//
// 为什么是 24 小时？
//   校园里买卖双方基本当天就会联系。超过一天还没确认，多半是这单黄了。
//   放回货架让别人能买，比继续占着更符合双方利益。
const EXPIRE_HOURS = 24;

// ============================================================
// 【开发期开关】已于 2026-09-21 关闭
// ============================================================
//
// 它当初为什么打开：正常的二手交易里，你不能买自己发的东西 —— 这个限制是对的。
// 但开发阶段只有一个微信号，不放开这个口子，就【完全没法测试】下单 →
// 确认 → 我买到的 这条主流程。
//
// 之前为了绕过这个问题，我让你去控制台手抄 openid 造数据，
// 结果抄进了一个同形异码的假字符，白折腾了三轮。
// 让代码开个口子，比让人手抄数据可靠得多。
//
// 为什么现在必须关：留着 true 上线，用户可以给自己下单，
// 凭空刷高「我买到的」里的数字 —— 一个只有自己能看到的假象，但它是脏数据。
//
// 关闭的前提是双账号买卖流程已经跑通（2026-09-21），不再需要这个口子。
// 注意：这个开关和 utils/cloud-config.js 里那个是同名镜像，
// 云函数独立部署、require 不到那个文件，所以只能写两份。搜索即可找到两处。
const DEV_ALLOW_SELF_BUY = false;

const G_ON_SALE = 'on_sale';
const G_LOCKED = 'locked';
const G_SOLD = 'sold';

const O_PENDING = 'pending';
const O_COMPLETED = 'completed';
const O_CANCELLED = 'cancelled';

const D_WAITING = 'waiting'; // 待接单
const D_ACCEPTED = 'accepted'; // 配送中
const D_DELIVERED = 'delivered'; // 已送达

const S_SMALL = 'small';
const S_LARGE = 'large';

// 配送费价目表。key 就是 delivery.size 的取值。
//
// ⚠️ 这是【下单当时】的价格，会连同 size 一起冻结进订单。
//    改这张表不影响已经下过的老单子。
const DELIVERY_FEE = {
  [S_SMALL]: 1,
  [S_LARGE]: 2
};

// 大件的分界线：商品单价【高于】这个数算大件，否则小件。
//
// ⚠️ 必须和 utils/cloud-config.js 里的同名常量一致！
//    云函数独立部署、require 不到那个文件，只能两处各写一份。
//    搜索 DELIVERY_LARGE_PRICE 能同时找到这两个地方。
//
// 【为什么定档看价格，而不是看体积和重量】
//   体积和重量要拿到实物才知道，可这笔钱必须在下单那一刻就告诉买家。
//   老规则（配送员看到实物再判）做不到这一点，下单页只能写
//   「具体多少由配送员判定，下单时无法预知」—— 那不是报价，是提前打预防针，
//   而预防针扎得再早，收货时那 1 块钱的争执还是在。
//   商品单价在下单时就是确定的，所以「下单页直接报出确切金额」
//   是跟着这条规则一起来的，不是顺带的好处。
const DELIVERY_LARGE_PRICE = 200;

// 按商品单价定档。【这是唯一决定 size 的地方】——
// delivery 的 size 和 fee 都从它出来，接单时不再重新判。
//
// 边界：恰好 200 算小件（「高于 200」才是大件）。等号倒向哪边是次要的，
//   要紧的是前端显示的那个数必须和这里一致 —— 一边含等号一边不含，
//   就会出现「下单页说 ¥1、订单里记 ¥2」这种没法对买家解释的账。
//
// 拿不到数字就当小件：快照是历史数据，防一手。
//   宁可少收，也不要在数据有问题的时候多扣买家的钱。
function sizeByPrice(price) {
  const n = Number(price);
  return Number.isFinite(n) && n > DELIVERY_LARGE_PRICE ? S_LARGE : S_SMALL;
}

// ============================================================
// 配送员白名单
// ============================================================
//
// 【怎么填】把你自己的 openid 粘进数组里，重新部署这个云函数。
//   openid 在哪看：云开发控制台 → 数据库 → users 集合 →
//   找到你自己那条记录 → 复制 _openid 字段。
//
// 【为什么写死在代码里，不建一个 admins 集合】
//   云函数的源码别人看不到，数据库集合却可能被人想办法读到 ——
//   后者等于把「谁是管理员」公开挂着。
//   而且 openid 永远不会变，压根不需要动态管理。
//   代价是改一次要重新部署一次；你只有一个人，这个代价可以接受。
//
// 【为什么默认是空数组】
//   空数组 = 谁都不是配送员。这是安全的默认值：
//   万一白名单机制被你绕过了，后果是「配送功能没人能用」，
//   而不是「所有人都能接单、都能看到别人的收货地址」。
//   配错的默认值必须往「什么都不给」的方向倒。
// 【V-08 修复：改成环境变量优先，源码里的值只作兼容兜底】
//
//  原来这份白名单只能靠改代码 + 重新部署来轮换。现在支持云函数
//  环境变量 ADMIN_OPENIDS（英文逗号分隔的多个 openid），优先级高于源码：
//    控制台 → 云函数 → order → 配置 → 环境变量 → 新增 ADMIN_OPENIDS
//  改完在控制台保存即可生效，不用重新部署；移除该变量则回落到下面这行。
//
//  ⚠️ 这个默认值是【空的】—— 仓库里不该出现任何人的真实 openid。
//     白名单为空时，没有谁拥有配送员权限，「配送管理」入口不会出现。
//
//     【怎么配】
//       方式一（推荐，不改代码）：云开发控制台 →
//         云函数 → order → 配置 → 环境变量 → 新增
//         ADMIN_OPENIDS = 你的openid,第二个openid
//         改完保存即生效，不用重新部署。
//       方式二：把 openid 填进下面这个数组，然后重新部署 order 云函数。
//
//     【openid 从哪来】
//       注册一个账号后进「我的 → 设置」（或在配送页点复制 openid），
//       那是【你自己】的 openid；要指定别人当配送员，让对方把自己的
//       openid 发给你。注意：填错了不会报错，只会「配送员看不到单」。
const DEFAULT_ADMIN_OPENIDS = [
  // '把你的openid填在这里'
];

const ADMIN_OPENIDS = (function () {
  const raw = String(process.env.ADMIN_OPENIDS || '').trim();
  if (!raw) return DEFAULT_ADMIN_OPENIDS;
  return raw
    .split(',')
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return !!s; });
})();

// 是不是配送员。所有配送相关的 action 第一行都得先过这一关 ——
// 前端的按钮藏起来只是「看不见」，不是「做不到」，
// 真正的门禁必须在服务端。
function isAdmin(openid) {
  return !!openid && ADMIN_OPENIDS.indexOf(openid) >= 0;
}

// 身份准入：调用者必须是【已完成核验】的用户（users.verified === true）。
//
// 【为什么下单这种"只是买个东西"的动作也要卡】
//   「学号 + 校内定位」是本项目的准入设计，但 verified 字段以前
//   只被注册流程写、没有任何写操作读 —— 门槛形同虚设。下单会让
//   自己的昵称头像快照被卖家看到、并导向线下见面交易，
//   是这个门槛最该负责的场景之一。
//
// 【和 user / publishGoods / chat 三处的关系】
//   云函数之间 require 不到，只能各写一份。四处的判据必须一致：
//   存在档案 且 verified === true。搜索 "verified !== true" 能同时找到四处，
//   改动其中一处时请一并核对其它三处。
async function requireVerified(openid) {
  const res = await db
    .collection(USERS)
    .where({ _openid: openid })
    .limit(1)
    .get()
    .catch(() => null);
  const user = (res && res.data && res.data[0]) || null;
  if (!user || user.verified !== true) {
    return { ok: false, code: 403, message: '请先完成校内身份核验后再下单' };
  }
  return { ok: true, user };
}

// ============================================================
// 订阅消息通知
// ============================================================
//
// 通知是【旁路】：它搭在业务流程旁边，不是业务流程的一部分。
// 这条线划得很清楚 —— 通知失败绝不能让订单失败。理由见 sendNotice 上方。
//
// 【微信的硬约束，也是这个功能的天花板：只开放「一次性订阅」】
//   长期订阅仅对特定行业开放，我们用不了。一次性订阅的意思是：
//     用户在页面上点一次「开启通知」 → 攒 1 条额度
//     成功发出 1 条                  → 消耗 1 条
//     额度用完后微信返回 43101（用户未订阅），这条通知就丢了
//   这不是 bug，是微信的规则。看到 43101 不要去「修」代码 ——
//   要么让用户再点一次按钮，要么以后换别的通知渠道（公众号 / 短信 / 站内红点）。
//
// 【为什么要在 config.json 里声明 permissions】
//   云函数调 cloud.openapi.* 属于「云调用」，微信要求先在 config.json 的
//   permissions.openapi 里点名声明要调哪个接口（这里是 subscribeMessage.send），
//   否则直接返回 -604101（no permission）。而且这个权限有【约 10 分钟缓存】，
//   刚上传完仍报 -604101 是正常的，等等再试，别急着改代码。

// 模板 ID —— 从微信后台「订阅消息 → 我的模板」复制来的那串 43 位字符。
//
// ⚠️ 抄这串字符时留意同形异码：里面可能同时出现
//    I（大写 i）、l（小写 L）、1（数字一），很多字体里长得一模一样。
//    这个项目为同一个坑栽过一次（手抄 openid 抄进一个假字符）。
//    万一抄错，靠错误码区分是哪一类问题：
//      模板 ID 错 → 40037（invalid template_id）
//      字段名错   → 47003（argument invalid）
const TPL_NEW_ORDER = 'YOUR_NEW_ORDER_TEMPLATE_ID';
//   字段名             含义            类型
//   thing7            商品名称         thing（20 字符内）
//   thing19           用户名称         thing
//   date6             下单时间         date
//   character_string2 订单编号         character_string

const TPL_ORDER_STATUS = 'YOUR_ORDER_STATUS_TEMPLATE_ID';
//   thing9  订单标题   thing
//   phrase3 订单状态   phrase（5 个以内纯汉字）

// 订单状态文案。
//
// phrase 类型要求「5 个以内【纯】汉字」—— 不能带标点、字母、数字。
// 「交易完成」4 个字 ✅　「已关闭」3 个字 ✅　写成「已完成!」就整条被拒。
//
// 值跟 utils/cloud-config.js 里的 ORDER_STATUS_TEXT 保持一致，
// 但【不能 require】：云函数独立部署，require 不到 utils/ 目录，
// 所以只能两处各写一份。搜索 ORDER_STATUS_TEXT 能同时找到这两个地方。
// 这是已知的两端分叉，不是 bug —— 前端那份只管显示，这份才是真正发出去的。
//
// 为什么只发「完成 / 关闭」两个终态，不发 pending：
//   中间的 pending 是买家自己刚做完的动作，推一条「你刚下了单」是废话。
//   通知要发在【用户不知情、又需要知道】的时刻。
const NOTICE_STATUS = {
  COMPLETED: '交易完成',
  CANCELLED: '已关闭'
};

// ============================================================
// 站内通知（兜底渠道）
// ============================================================
//
// 【为什么要再做一套，订阅消息不是有了吗】
//   订阅消息是【一次性】的：用户点一次按钮攒 1 条额度，发一条就没了，
//   之后微信返回 43101。也就是说通知发不发得出去，取决于用户
//   上次点「开启通知」是什么时候 —— 这件事我们控制不了。
//   站内通知不依赖任何授权：写进数据库，用户进小程序就能看到。
//   它不吵不闹，但【一定送得到】。
//
//   两者是互补不是替代：订阅消息负责「把人叫回来」，
//   站内通知负责「人回来了，东西还在」。
//   所以下面 notifyNewOrder / notifyOrderStatus 里【两个都发】。
//
// ⚠️ 集合名要和 utils/cloud-config.js 的 COLLECTION.NOTIFICATIONS 一致。
//    搜索 NOTIFICATIONS 能同时找到这两个地方。
const NOTIFICATIONS = 'notifications';

// 站内通知的类型。前端靠它决定图标和跳转，不要改字符串值 ——
// 库里已经写进去的老记录用的就是这些值。
const N_ORDER_NEW = 'order_new'; // 有人买你的东西（发给卖家）
const N_ORDER_STATUS = 'order_status'; // 你的订单有结果了（发给买家）

// 写一条站内通知。
//
// 【和 sendNotice 同一条纪律：永远不 throw】
//   通知是旁路，不能让它掀桌子。差别在于这里更不该失败 ——
//   订阅消息失败有平台原因（额度用完了），写库失败基本只有
//   「集合没建」和「网络抖」两种，都属于运维该看日志、用户不该等的事。
//   所以 catch 里只 warn，不往上抛。
async function writeNotification(openid, payload) {
  if (!openid) return false;
  try {
    await db.collection(NOTIFICATIONS).add({
      data: {
        // 云函数 add 不会自动写 _openid，必须手动带。
        // 这里存的语义是【收件人】—— 查「我的通知」全靠它，
        // 漏了的话这条通知谁都看不到，而且不报错。
        _openid: openid,
        type: payload.type,
        title: payload.title,
        body: payload.body,
        // 点这条通知跳哪去。和订阅消息的 page 是同一个去处 ——
        // 两个渠道指向同一个页面，用户从哪进来体验都一样。
        page: payload.page,
        // 关联的订单号。现在只用来去重和排查，
        // 将来要做「订单详情」页的话直接就能用上。
        orderId: String(payload.orderId || ''),
        // 已读标记。不存成「已读列表」是因为收件人是自己的：
        // 一条记录一个 read 位，比维护一个 id 数组简单且不会写坏。
        read: false,
        createTime: new Date()
      }
    });
    console.log('[站内通知] 已写入 type=' + payload.type + ' to=' + openid);
    return true;
  } catch (err) {
    // 最常见的就是「notifications 集合还没建」。
    // 打成 warn 不打 error：这一条日志不该混进真正影响下单的故障里。
    console.warn(
      '[站内通知] 写入失败 type=' + payload.type +
      ' errMsg=' + (err && err.message)
    );
    return false;
  }
}

// 跳转小程序类型：developer 开发版 / trial 体验版 / formal 正式版。
//
// 【V-08 修复：上线前必须改的那个值，已经改了】
//   它决定的是「用户点开这条订阅消息时，跳到哪个版本的小程序」，
//   不是「用哪个版本发的」。填错的两个方向都很坑：
//     developer → 正式用户点开通知会被丢进开发版，等同于打不开；
//     无正式版时填 formal → 通知【发得出去】，但点开一片空白。
//   这类失败只发生在别人手机上，你这边一条报错都看不到，最难查。
//
//   现在是 formal（正式版）。若本次是上线前联调、需要通知跳到体验版，
//   临时改回 'trial'，发版前务必改回来。该常量随云函数部署生效，
//   不需要小程序发版。
const MINIPROGRAM_STATE = 'formal';

// thing 类型最多 20 个字符 —— 超了不是自动截断，是【整条消息被拒】（47003）。
// 商品标题最多允许 30 字、昵称也没限长，所以必须自己先截。
//
// 用 Array.from 而不是 String.prototype.slice：昵称里的 emoji 在 JS 里
// 占两个字符位置，slice 会从中间把它劈开，切出半个非法字符发出去。
function clip(text, max) {
  const chars = Array.from(String(text || '').trim());
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('');
}

// 微信 date 类型只认 'YYYY-MM-DD HH:mm' 这种写法（也接受中文年月日）。
// Date.toISOString() 返回 '2026-09-23T12:15:00.000Z'，
// 看着更「标准」，微信不认 —— 又是一个 47003。
//
// ⚠️ 时区：这里取的是运行时本地时区。order 云函数若没配 TZ，
//    默认跑在 UTC+0，通知里的时间会【少 8 小时】
//    （晚上 8 点下的单，通知里显示中午 12 点）。
//    配置位置：云开发控制台 → 云函数 → order → 配置 → 环境变量 → TZ = Asia/Shanghai
function formatDateTime(d) {
  const p = (n) => (n < 10 ? '0' + n : String(n));
  return (
    d.getFullYear() +
    '-' + p(d.getMonth() + 1) +
    '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) +
    ':' + p(d.getMinutes())
  );
}

// 发送订阅消息。旁路操作 ——【永远不 throw】，失败只写日志。
//
// 为什么这条纪律不能松：订阅消息失败的原因多得离谱 ——
//   43101 用户没订阅 / 额度用完了
//   40037 模板 ID 抄错
//   47003 字段名错、内容超长、date 格式不对
//   41030 模板被删掉了
// 只要漏包一次，就会变成「卖家点了确认卖出，界面弹『操作失败』」，
// 而他一查数据库，东西明明已经卖了 —— 业务成功了，提示说失败了。
// 这种「报错和事实相反」的 bug 会让人往完全错误的方向查。
// 通知是锦上添花，不能让它掀桌子。
async function sendNotice(openid, templateId, page, data) {
  if (!openid) return false;
  try {
    await cloud.openapi.subscribeMessage.send({
      touser: openid,
      templateId,
      page,
      data,
      miniprogramState: MINIPROGRAM_STATE,
      lang: 'zh_CN'
    });
    // 成功也要打日志，别只在失败时打。
    //
    // 只记失败的话，「日志里没有失败」这句就只能证明【可能没调用】，
    // 不能证明【调用成功了】—— 两者在日志上长得一模一样。
    // 有了这条，「发送成功」和「压根没走到这里」才区分得开。
    console.log('[订阅消息] 已发送 template=' + templateId + ' touser=' + openid);
    return true;
  } catch (err) {
    // 用 warn 不用 error：额度用完（43101）是预期内的高频情况，
    // 打成 error 会把真正的故障淹在噪音里，以后没人看日志。
    console.warn(
      '[订阅消息] 发送失败 errCode=' + (err && err.errCode) +
      ' errMsg=' + (err && err.errMsg) +
      ' template=' + templateId
    );
    return false;
  }
}

// 通知卖家：有人下单了
//
// 【两个渠道都发，包在同一个函数里是故意的】
//   订阅消息和站内通知是同一件事的两个投递方式，
//   在调用点各写一行的话，将来加第三个渠道就要改三处
//   （create 只调用一次这里，但 notifyOrderStatus 有三个调用点）。
//   收在这里，三个调用点一行都不用动。
//
//   两边都【不 throw】，所以 Promise.all 不会因为通知失败而 reject，
//   下单流程该成功还是成功。
function notifyNewOrder(goods, buyer, orderId, time) {
  return Promise.all([
    // 渠道一：微信订阅消息（能不能送到看用户有没有额度）
    sendNotice(goods._openid, TPL_NEW_ORDER, 'pages/my_sold/my_sold', {
      thing7: { value: clip(goods.title, 20) },
      thing19: { value: clip(buyer.nickname, 20) },
      date6: { value: formatDateTime(time) },
      character_string2: { value: clip(String(orderId), 32) }
    }),
    // 渠道二：站内通知（一定送得到）
    writeNotification(goods._openid, {
      type: N_ORDER_NEW,
      title: '有人想买你的东西',
      body: clip(buyer.nickname, 20) + ' 买下了「' + clip(goods.title, 20) + '」，等你确认',
      page: 'pages/my_sold/my_sold',
      orderId
    })
  ]);
}

// 通知买家：订单走到终态了。
// 三个地方会调用它（卖家确认 / 卖家拒绝 / 超时自动关闭），
// 内容只差一个状态词，收在一个函数里 —— 以后改文案只改一处。
//
// 订单标题取的是 order.goods.title，也就是【下单那一刻的快照】。
// 商品后来被改名或删掉都不影响这里，和订单记录本身的口径一致。
function notifyOrderStatus(order, statusText) {
  const title = clip((order.goods || {}).title, 20);
  const done = statusText === NOTICE_STATUS.COMPLETED;

  return Promise.all([
    // 渠道一：微信订阅消息
    sendNotice(order._openid, TPL_ORDER_STATUS, 'pages/my_buy/my_buy', {
      thing9: { value: title },
      phrase3: { value: statusText }
    }),
    // 渠道二：站内通知
    //
    // 【正文要写清楚是买家还是卖家】
    //   这一条是发给买家的，但 body 里不能只写「「xxx」交易完成」——
    //   买家可能同时是另一个订单的卖家，看到一句话分不清是哪一单。
    //   所以正文里点名「你买的」。
    writeNotification(order._openid, {
      type: N_ORDER_STATUS,
      title: done ? '交易完成' : '订单已关闭',
      body: done
        ? '你买的「' + title + '」卖家已确认，交易完成'
        : '你买的「' + title + '」已被关闭',
      page: 'pages/my_buy/my_buy',
      orderId: order._id
    })
  ]);
}

// 取用户昵称头像（用于订单快照）。查不到就用兜底值，不让订单因为
// 用户没填资料而创建失败。
//
// ⚠️【白名单：这个对象会被写进订单，然后给【对方】看】
//    下单时它同时给买家和卖家各存一份快照，之后 listMine / listReceived /
//    配送池都从这里取名字。所以这里返回什么，等于让对方看到什么。
//    users 档案里的 realName（真实姓名）【绝不能】加进来 ——
//    真实姓名只有管理员和用户本人可见。
//    加字段前先问：这个值是要给交易的对方看的吗？
//
//    同一约束还在另外两处（也都是给「别人」造快照）：
//      cloudfunctions/publishGoods/index.js  buildPublisher
//      cloudfunctions/chat/index.js          profileOf
//    搜索 realName 能同时找到这几个地方。
async function getUserBrief(openid) {
  const res = await db
    .collection(USERS)
    .where({ _openid: openid })
    .limit(1)
    .get()
    .catch(() => null);

  const user = (res && res.data && res.data[0]) || {};
  return {
    nickname: user.nickname || '校园用户',
    avatar: user.avatar || ''
  };
}

// 取下单时的收货地址快照。
//
// 这里直接读 address 集合，不调 address 云函数 ——
// 云函数之间没法互相调用，而且两者连的是同一个数据库，
// 直接读比绕一圈简单得多。
//
// 归属校验【不能省】：少了它，买家可以传别人的 addressId，
// 把别人的姓名电话地址写进自己的订单，然后配送员照着去送。
async function getDeliveryAddress(openid, addressId) {
  if (!addressId) return { ok: false, message: '请选择收货地址' };

  const res = await db.collection(ADDRESS).doc(addressId).get().catch(() => null);
  const addr = res && res.data;
  if (!addr) return { ok: false, message: '收货地址不存在' };

  // 不是自己的地址，统一说「不存在」，不要说「无权限」——
  // 「无权限」等于告诉对方「这个 id 是真实存在的」，
  // 拿它逐个试就能探出别人有几个地址、id 长什么样。
  if (addr._openid !== openid) {
    return { ok: false, message: '收货地址不存在' };
  }

  return {
    ok: true,
    snapshot: {
      name: addr.name || '',
      phone: addr.phone || '',
      campus: addr.campus || '',
      detail: addr.detail || ''
    }
  };
}

// ============================================================
// 买家下单
// ============================================================
//
// deliveryType: '' 或 'self' = 自提（和以前完全一样，订单上没有 delivery 字段）
//               'delivery'   = 配送，必须同时给 addressId
async function create(openid, goodsId, deliveryType, addressId) {
  // 【V-04 修复】下单前先过身份准入。
  //
  // 【为什么下单必须卡这道门】
  //   下单是全链路里唯一的成交动作：它会锁商品状态、产生订单文档、
  //   把双方的交易地点与联系方式卷进来。以前只要能把商品 ID 报出来
  //   就能下单 —— 未核验的账号（叠加 V-03 的坐标伪造，等于完全无需核验）
  //   可以完整参与交易。这道门必须由服务端把关。
  //
  // 【为什么放在最前面】
  //   下面每一步（查商品、查地址、改状态）都要读库甚至写库，
  //   不合格的请求不该产生这些开销。
  const gate = await requireVerified(openid);
  if (!gate.ok) {
    return { code: gate.code, message: gate.message };
  }

  if (!goodsId) return { code: 1, message: '缺少商品 ID' };

  const goodsRes = await db.collection(GOODS).doc(goodsId).get().catch(() => null);
  const goods = goodsRes && goodsRes.data;
  if (!goods) return { code: 1, message: '商品不存在或已删除' };

  // 正常业务规则：不能买自己发的东西。
  // 保留 !DEV_ALLOW_SELF_BUY 这个条件而不是写死，是为了让这个开关
  // 仍然是「活的」—— 以后要再单账号测一遍下单流程，翻回 true 就能用。
  // 现在是 false，所以等价于「无条件禁止」。
  if (goods._openid === openid && !DEV_ALLOW_SELF_BUY) {
    return { code: 1, message: '不能购买自己发布的商品' };
  }
  if (goods.status !== G_ON_SALE) {
    return { code: 1, message: '该商品当前不可购买' };
  }

  // ===== 价格合法性：这是在给历史脏数据兜底 =====
  //
  // PRICE_MAX 这条规则是后加的，在此之前售价没有任何上限，
  // 库里已经躺着 ¥1e+25 和 ¥999999 这种商品。它们不是「贵」，是【不是价格】——
  // 1e25 渲染出来是科学计数法，没有用户能读出那是多少钱。
  //
  // 与其去数据库里手工清理，不如在这里拒绝成交：脏数据商品自动变成买不了的，
  // 卖家想卖就得回去把价格改成一个真实数字（改的时候会被 manageGoods 的上限拦住）。
  // 这是「规则上线前的数据由规则自己消化」，不需要一次性迁移脚本。
  //
  // ⚠️ 上限值和 utils/cloud-config.js、publishGoods、manageGoods 里的必须一致。
  //    搜索 PRICE_MAX 能找到全部四处 —— 这是第四处，也是最后一道。
  if (!Number.isFinite(goods.price) || goods.price <= 0 || goods.price > PRICE_MAX) {
    return { code: 1, message: '该商品的价格不合法，暂时无法购买' };
  }

  // ===== 地址校验：必须在抢锁【之前】=====
  //
  // 会失败的校验都放锁前，不会失败的取数据都放锁后 —— 这条线划分的依据是
  // 「失败之后要不要善后」，不是「快不快」：
  //
  //   锁后失败 → 商品已经被锁成 locked 了，必须写一段回滚把它放回货架。
  //              回滚路径是额外的一处代码，额外的一处会出错的地方。
  //   锁前失败 → 什么都没发生，直接 return 就行，没有善后。
  //
  // 对比下面的 getUserBrief：那个函数查不到用户会自己兜底成「校园用户」，
  // 【永远不会失败】，所以放锁后是安全的。
  let delivery = null;
  if (deliveryType === 'delivery') {
    const addr = await getDeliveryAddress(openid, addressId);
    if (!addr.ok) return { code: 1, message: addr.message };

    // 档位在这里就定下来，不留到接单时 ——
    //   池子里的卡片要显示「接这单能拿多少」，买家也要在下单页
    //   看到同一个数，两处都得在这张单子还没人接的时候就成立。
    // 价钱取自【上面读到的那个商品快照】，和下面写进订单的 price
    //   是同一个值，所以显示的和记下的不会打架。
    const size = sizeByPrice(goods.price);
    const fee = DELIVERY_FEE[size];

    delivery = {
      status: D_WAITING,
      size,
      fee,
      courierOpenid: '',
      address: addr.snapshot,
      acceptTime: null,
      deliverTime: null
    };
  }

  const now = new Date();

  // ===== 锁单：整个模块最关键的一行 =====
  //
  // 这是「带条件的更新」，也就是 compare-and-swap（CAS）。
  //
  // 为什么不能写成「先查商品是不是 on_sale，再 update 成 locked」？
  //   查完到写入之间有一个窗口。两个买家同时下单，都能查到 on_sale，
  //   然后都写入 locked —— 锁单直接失效，两个人都以为自己抢到了。
  //
  // 为什么现在这行能防住？
  //   where 条件和 update 动作是【一条指令】发下去的。MongoDB 对单文档的
  //   更新是原子的，并发请求会被串行执行：
  //     第一个执行完，status 已经是 locked
  //     第二个的过滤条件 status:'on_sale' 不再匹配，命中 0 条
  //   所以判断依据就是 stats.updated —— 1 代表我抢到了，0 代表别人先到了。
  //
  // 这个套路是通用的：以后做库存扣减、抢单、秒杀、优惠券领取，
  // 用的都是同一招。
  const lockRes = await db
    .collection(GOODS)
    .where({ _id: goodsId, status: G_ON_SALE })
    .update({ data: { status: G_LOCKED, lockTime: now, updateTime: now } });

  if (!lockRes.stats || lockRes.stats.updated !== 1) {
    return { code: 1, message: '手慢了，已经有买家抢先下单' };
  }

  // 抢到锁之后才去查用户资料、写订单。
  // 顺序很重要：这些操作慢，放在抢锁之前会拉长竞态窗口。
  const [buyer, seller] = await Promise.all([
    getUserBrief(openid),
    getUserBrief(goods._openid)
  ]);

  const orderDoc = {
    _openid: openid,
    sellerOpenid: goods._openid,
    goodsId,
    goods: {
      title: goods.title,
      price: goods.price,
      image: (goods.images && goods.images[0]) || '',
      campus: goods.campus || ''
    },
    buyer,
    seller,
    status: O_PENDING,
    cancelReason: '',
    createTime: now,
    finishTime: null
  };

  // 自提单【不写】这个字段，而不是写成 delivery: null。
  // 原因是「有没有这个字段」本身就是「是不是配送单」的判据 ——
  // 写个 null 进去，_.exists(true) 这类查询会把它也算进来，
  // 于是自提单会混进配送池。留空比留 null 干净。
  if (delivery) orderDoc.delivery = delivery;

  try {
    const res = await db.collection(ORDERS).add({ data: orderDoc });

    // 通知卖家：有人下单了。
    //
    // 这里用 await，不是「发出去就不管」。原因：云函数在 return 之后
    // 随时可能被冻结销毁，那些没 await 的异步操作会被【静默掐掉】——
    // 一个字都不会进日志，你只会发现「通知时有时无」。
    // 多等这一次网络往返，换「通知真的发出去了」。
    await notifyNewOrder(goods, buyer, res._id, now);

    return { code: 0, message: '下单成功，等待卖家确认', orderId: res._id };
  } catch (err) {
    // ===== 补偿：抢到锁但订单没写进去 =====
    // 不加这一步，商品会永远卡在 locked：谁都买不了，卖家也确认不了，
    // 只能去控制台手动改数据。这类「资源被占住但业务没完成」的情况，
    // 一定要有回滚路径。
    console.error('order add failed, rolling back lock:', err);
    await db
      .collection(GOODS)
      .doc(goodsId)
      .update({
        data: { status: G_ON_SALE, lockTime: _.remove(), updateTime: new Date() }
      })
      .catch((e) => console.error('rollback lock failed:', e));

    return { code: -1, message: '下单失败，请重试' };
  }
}

// ============================================================
// 卖家确认卖出
// ============================================================
//
// sellerPhone: 配送单必传（自提单会被忽略）。
//   前端在卖家没填过手机号时弹一次输入框问他要，填过就直接带上来。
async function confirm(openid, orderId, sellerPhone) {
  if (!orderId) return { code: 1, message: '缺少订单 ID' };

  const orderRes = await db.collection(ORDERS).doc(orderId).get().catch(() => null);
  const order = orderRes && orderRes.data;
  if (!order) return { code: 1, message: '订单不存在' };
  if (order.sellerOpenid !== openid) {
    return { code: 1, message: '无权操作该订单' };
  }
  if (order.status !== O_PENDING) {
    return { code: 1, message: '该订单已处理过，不能重复操作' };
  }

  // ===== 配送单：先要取货电话 =====
  //
  // 【位置很关键】必须放在改商品状态【之前】。
  //   放在后面的话，就会出现：商品已经被标成 sold、订单却因为
  //   没电话而确认失败 —— 东西卖出去了，订单还挂着 pending，
  //   商品也回不到货架。校验一律挡在第一个写操作前面。
  //
  // 为什么只有配送单要：自提是买卖双方自己约时间地点，
  //   平台不参与取货，问这个号码没用。
  //
  // 为什么写进订单快照，而不是让配送员去查用户资料：
  //   和 goods 快照同一个道理 —— 订单是历史凭证。卖家以后换了号，
  //   这一单该显示的还是当时的号。而且配送员读订单时不用多查一次表。
  const patch = { status: O_COMPLETED };

  if (order.delivery) {
    const phone = String(sellerPhone || '').trim();
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      // code 用 2 而不是 1：前端要靠它区分「就是缺电话」和
      // 「别的失败（比如商品已被别人买走）」，前者该弹输入框，后者不该。
      return { code: 2, message: '配送单需要留一个取货电话', needPhone: true };
    }
    patch['delivery.sellerPhone'] = phone;
  }

  const now = new Date();
  patch.finishTime = now;

  // 这里【必须】重新校验商品状态，不能相信订单里记着的状态。
  // 卖家点确认的那一刻，商品可能已经：
  //   - 被卖家在「我发布的」里直接点「卖出」了（status 已变 sold）
  //   - 被下架了
  // 同样用条件更新，命中 0 条就说明状态变了，直接拒绝。
  const saleRes = await db
    .collection(GOODS)
    .where({ _id: order.goodsId, status: G_LOCKED })
    .update({ data: { status: G_SOLD, soldTime: now, updateTime: now } });

  if (!saleRes.stats || saleRes.stats.updated !== 1) {
    return { code: 1, message: '商品状态已变化（可能已被卖出或下架），无法确认' };
  }

  // 先改商品、后改订单。顺序不能反：
  // 万一第二步失败，至少商品状态是对的（东西确实卖了），
  // 订单停在 pending 虽然难看，但可以人工修；
  // 反过来则会出现「订单显示已完成，商品却还在货架上」。
  //
  // 订单必须带 status:'pending' 条件更新。买家取消和卖家确认并发时，
  // 无条件 doc.update 会把已取消的单写成 completed，或把已成交的单写成 cancelled。
  // 抢不到订单就回滚刚才的 sold，商品回到货架 —— 和「这单没成交」一致。
  //
  // patch 里除了 status/finishTime 还可能是 delivery.sellerPhone。
  // 用「.」拼出来的键名是云数据库的点路径写法，会把值写进子文档，
  // 而不是建一个叫 "delivery.sellerPhone" 的怪字段。
  const orderUp = await db
    .collection(ORDERS)
    .where({ _id: orderId, status: O_PENDING, sellerOpenid: openid })
    .update({ data: patch });

  if (!orderUp.stats || orderUp.stats.updated !== 1) {
    await db
      .collection(GOODS)
      .where({ _id: order.goodsId, status: G_SOLD })
      .update({
        data: {
          status: G_ON_SALE,
          soldTime: _.remove(),
          lockTime: _.remove(),
          updateTime: now
        }
      })
      .catch((e) => console.error('confirm rollback goods failed:', e));
    return { code: 1, message: '该订单已处理过，不能重复操作' };
  }

  // 顺手把这回问到的电话存进用户资料，下次就不再问他了。
  //
  // 【必须 .catch 兜住】这是一步旁路操作，跟本次「确认卖出」这件事
  // 没有关系 —— 存资料失败不该让卖家觉得「确认卖出失败了」。
  // 订单已经写完了，这里再抛错，前端收到的就是失败，
  // 而卖家会去点第二次，第二次反而因为订单已完成被拒。
  if (patch['delivery.sellerPhone']) {
    db.collection(USERS)
      .where({ _openid: openid })
      .update({
        data: { phone: patch['delivery.sellerPhone'], updateTime: now }
      })
      .catch((err) => console.warn('回写用户手机号失败：', err));
  }

  // 通知买家：卖家点头了，交易完成。
  // 这是买家最想知道的一条 —— 他下了单就退出小程序了，
  // 不推这一条，他只能靠自己反复打开「我买到的」来看卖家有没有理他。
  await notifyOrderStatus(order, NOTICE_STATUS.COMPLETED);

  return { code: 0, message: '已确认卖出' };
}

// ============================================================
// 关闭订单（买家取消 / 卖家拒绝，同一套逻辑，只是权限不同）
// ============================================================
async function closeOrder(openid, orderId, reason) {
  if (!orderId) return { code: 1, message: '缺少订单 ID' };

  const orderRes = await db.collection(ORDERS).doc(orderId).get().catch(() => null);
  const order = orderRes && orderRes.data;
  if (!order) return { code: 1, message: '订单不存在' };

  // 买卖双方都有权关掉这笔订单，其他任何人都不行
  if (order._openid !== openid && order.sellerOpenid !== openid) {
    return { code: 1, message: '无权操作该订单' };
  }
  // 终态保护：已完成/已关闭的订单不能再关一次。
  // 少了这一条，用户可以反复点「取消」把一笔已完成的交易改成已关闭。
  if (order.status !== O_PENDING) {
    return { code: 1, message: '该订单已处理过，不能重复操作' };
  }

  const now = new Date();

  // 条件更新：和 confirm 抢同一把锁。无条件 doc.update 会在卖家刚把
  // 商品标成 sold 之后，仍把订单改成 cancelled，留下「货卖了、单关了」。
  const closeRes = await db
    .collection(ORDERS)
    .where({ _id: orderId, status: O_PENDING })
    .update({
      data: { status: O_CANCELLED, cancelReason: reason || '', finishTime: now }
    });

  if (!closeRes.stats || closeRes.stats.updated !== 1) {
    return { code: 1, message: '该订单已处理过，不能重复操作' };
  }

  // 把商品放回货架。同样用条件更新：只有它还停在 locked 才放回去。
  // 不加 status:'locked' 这个条件的话，会把一件已经 sold 的商品
  // 重新变成 on_sale —— 卖出去的东西又上架了。
  await db
    .collection(GOODS)
    .where({ _id: order.goodsId, status: G_LOCKED })
    .update({
      data: { status: G_ON_SALE, lockTime: _.remove(), updateTime: now }
    });

  // 通知买家 —— 但只在他【不是关单的人】的时候。
  //
  // 买家自己点的「取消订单」，事后再推他一条「订单已关闭」是打扰：
  // 他刚做完这个动作，比谁都清楚。真正需要让他知道的是【他不知道的那些】——
  // 卖家拒绝了你。区分「是谁触发的」比区分「发生了什么」更有用。
  //
  // 这也是「一次性订阅额度」该省着用的地方：每推一条就消耗一条，
  // 拿它去说用户已经知道的事，等他真需要通知时就没了。
  if (order._openid !== openid) {
    await notifyOrderStatus(order, NOTICE_STATUS.CANCELLED);
  }

  return { code: 0, message: '订单已关闭' };
}

// ============================================================
// 自动关闭超时未处理的订单（由定时触发器调用，没有 OPENID）
// ============================================================
//
// hours 参数保留是为了「可手动验证」：正式跑由定时器传 EXPIRE_HOURS。
// 想手工跑一次，去云开发控制台 → 云函数 → order → 云端测试，发这个 event：
//     { "Type": "Timer" }
// 它会走定时器那条分支，用的是 EXPIRE_HOURS，不会误伤刚下单的订单。
//
// 之所以不再提供一个「能自定义 hours」的外部动作：那等于对外开放了一个
// 不用登录就能清空全站待确认订单的接口。
async function autoCloseExpired(hours) {
  const deadline = new Date(Date.now() - hours * 3600 * 1000);

  const res = await db
    .collection(ORDERS)
    .where({ status: O_PENDING, createTime: _.lt(deadline) })
    .limit(100)
    .get();

  const expired = res.data || [];
  if (expired.length === 0) return { code: 0, closed: 0, message: '没有超时订单' };

  const now = new Date();
  let closed = 0;

  // 为什么逐条处理，不用一次批量 update？
  //   批量 update 只能对订单集合生效，而每关掉一笔订单，
  //   还要去释放它【对应的那一件】商品 —— 每条的 goodsId 都不一样，
  //   批量做不到。好在超时订单一天也就几笔，逐条完全够。
  for (const order of expired) {
    // 条件更新，和用户操作抢时间：
    //   定时器扫出这批订单之后、真正关它之前，买家可能正好点了「取消」，
    //   或者卖家点了「确认」。带上 status:'pending' 条件，
    //   别人先处理了就命中 0 条，直接跳过，不会覆盖已成的事实。
    const closeRes = await db
      .collection(ORDERS)
      .where({ _id: order._id, status: O_PENDING })
      .update({
        data: {
          status: O_CANCELLED,
          cancelReason: '超过 ' + hours + ' 小时未确认，系统自动关闭',
          finishTime: now
        }
      });

    if (!closeRes.stats || closeRes.stats.updated !== 1) continue;

    // 同样带 status:'locked' 条件，只把还锁着的商品放回货架
    await db
      .collection(GOODS)
      .where({ _id: order.goodsId, status: G_LOCKED })
      .update({
        data: { status: G_ON_SALE, lockTime: _.remove(), updateTime: now }
      });

    // 通知买家：系统替你把这单关了。
    // 这单大概率是他自己忘了（或者卖家没理他），但他不一定知道 ——
    // 商品已经回到货架，别人随时可能买走。他该知道这件事，
    // 而不是过两天打开「我买到的」才发现订单没了。
    await notifyOrderStatus(order, NOTICE_STATUS.CANCELLED);

    closed++;
  }

  console.log('autoCloseExpired: 扫描到 ' + expired.length + ' 笔超时订单，关闭了 ' + closed + ' 笔');
  return { code: 0, closed, scanned: expired.length, message: '关闭了 ' + closed + ' 笔超时订单' };
}

// 我买到的
async function listMine(openid) {
  const res = await db
    .collection(ORDERS)
    .where({ _openid: openid })
    .orderBy('createTime', 'desc')
    .limit(100)
    .get();
  return { code: 0, message: 'ok', list: res.data || [] };
}

// 我收到的订单（我是卖家）
//
// 顺带把卖家自己的手机号返回给前端。不是「顺手多查一下」，是因为
// 前端【必须】先知道有没填过电话，才能决定点「确认卖出」时
// 要不要弹输入框 —— 把这个问题留给前端判断，云函数就只做一件事：
// 你没给电话、而这单又要配送，我就拒绝。
async function listReceived(openid) {
  const [orderRes, userRes] = await Promise.all([
    db
      .collection(ORDERS)
      .where({ sellerOpenid: openid })
      .orderBy('createTime', 'desc')
      .limit(100)
      .get(),
    db
      .collection(USERS)
      .where({ _openid: openid })
      .limit(1)
      .get()
      .catch(() => null)
  ]);

  const me = userRes && userRes.data && userRes.data[0];

  return {
    code: 0,
    message: 'ok',
    list: orderRes.data || [],
    // 查不到人也给空串，前端只认「有值 / 没值」两种状态
    myPhone: (me && me.phone) || ''
  };
}

// ============================================================
// 配送
// ============================================================
//
// 下面每个函数的第一行都是 isAdmin 检查。
// 前端的按钮藏起来只是「看不见」，不是「做不到」——
// 有个现成的反例：买家改一下请求就能传别人的 addressId 试试看。
// 前端的判断负责【体验】，服务端的判断才负责【安全】。

// 待接单池对外的字段白名单。
//
// 【为什么必须在这里裁，而不是前端不显示就完了】
//   池子里的每一单都带着 delivery.sellerPhone（卖家取货电话）和
//   delivery.address 里的买家姓名 / 电话 / 详细地址。前端不渲染只是
//   「看不见」—— 抓个包，或者改一下前端，就全拿走了。
//   和 isAdmin 是同一个道理：前端的判断负责【体验】，服务端的判断负责【安全】。
//
// 【为什么是白名单，不是黑名单】
//   黑名单（delete 掉几个字段）的问题是：以后给订单加一个新字段，
//   得有人想起来回来问一句「这个该不该给配送员看」，漏一次就漏一个。
//   白名单反过来 —— 新字段默认【不给】，要显式加进来才出得去。
//   配错的默认值必须往「什么都不给」的方向倒。
//
// 接单【前】配送员需要的只有这些：认得出是哪件东西（好判断大小件）、
// 去哪取、送到哪个宿舍。手机号一个都不给 ——
// 接了单才在 myDeliveries 里看得到，那边的查询条件本身就限定了
// 「只返回我接的单」。
function poolView(order) {
  const goods = order.goods || {};
  const delivery = order.delivery || {};
  const address = delivery.address || {};

  // 档位和费用是【算出来的】，不是读 delivery.fee。
  //
  // 【为什么池子里可以算，别处却必须读冻结值】
  //   待接单的单子还没有人认领 —— 这笔钱没有跟任何人达成过约定，
  //   它只是「按商品单价和当前价目表算出来是多少」。
  //   一旦被接单，acceptDelivery 会把它写进 delivery.fee 冻住，
  //   从那一刻起才只读那个值（订单是历史凭证：价目表以后再改，
  //   已经送掉的单子显示的仍是当时那个价）。
  //   所以规矩是：waiting 算，accepted / delivered 读。
  //
  //   顺带修好一种老数据：这份定价规则上线之前创建的订单存的是
  //   fee: 0（那时候费用留到接单时才定）。直接读会显示「配送费 ¥0」，
  //   配送员看了以为要白跑 —— 可一旦他接下去，acceptDelivery 又会
  //   按商品单价写出正确的费用。显示的和实际拿到的必须一致，
  //   所以这里跟着算。
  const size = sizeByPrice(goods.price);

  return {
    _id: order._id,
    goodsId: order.goodsId,
    goods: {
      title: goods.title || '',
      price: goods.price || 0,
      image: goods.image || '',
      // 取货点。商品自己的交易地点，不是卖家的常驻宿舍。
      // 存的是发布时的原样整串（「松园·松一」或老数据的「松园」），
      // 订单快照不做任何加工 —— 以后改楼栋命名，老单子显示的仍是当时的写法。
      campus: goods.campus || ''
    },
    delivery: {
      status: delivery.status,
      size,
      // 接这单能拿多少。和下面的宿舍一起，构成配送员判断
      // 「这趟值不值得跑」的全部依据 —— 他不用自己算。
      fee: DELIVERY_FEE[size],
      // 只留宿舍：name / phone / detail 是买家的个人信息，接了单再说。
      // 宿舍本身不敏感（池子本来就是所有配送员共看的），
      // 但它是判断「远不远、顺不顺路」绕不开的。
      address: { campus: address.campus || '' }
    },
    finishTime: order.finishTime
  };
}

// 待接单的配送单。
//
// 【为什么条件是「订单已完成」而不是「订单待确认」】
//   卖家还没点头，东西就还不算卖出去，配送员跑去送什么？
//   所以下单时虽然就写了 delivery.status='waiting'，但它得等
//   卖家确认（订单变 completed）才会出现在这个池子里。
//   这么做的好处是 confirm() 一行都不用改。
//
// 【为什么这里的返回要过 poolView】
//   这个池子是【所有配送员共看】的，而上面那些字段是买卖双方的私人信息。
//   详见 poolView 上方的说明。
async function deliveryPool(openid) {
  if (!isAdmin(openid)) return { code: 1, message: '你不是配送员' };

  const res = await db
    .collection(ORDERS)
    .where({
      status: O_COMPLETED,
      'delivery.status': D_WAITING
    })
    .orderBy('finishTime', 'desc')
    .limit(100)
    .get();

  return { code: 0, message: 'ok', list: (res.data || []).map(poolView) };
}

// 我接的配送单（配送中 + 已送达）
async function myDeliveries(openid) {
  if (!isAdmin(openid)) return { code: 1, message: '你不是配送员' };

  const res = await db
    .collection(ORDERS)
    .where({ 'delivery.courierOpenid': openid })
    .orderBy('delivery.acceptTime', 'desc')
    .limit(100)
    .get();

  return { code: 0, message: 'ok', list: res.data || [] };
}

// 接单。
//
// 【这里不再判大小】—— size 和 fee 都由商品单价定，跟谁来接、什么时候接无关。
// 配送员能做的只有「接」这一个动作，没有可选项。
//
// 为什么用条件更新（和上面锁单同一招）？
//   以后配送员不止一个时，两个人同时点「接单」会把同一单接两次：
//   后者覆盖前者的 courierOpenid，第一单的配送员白跑一趟。
//   带上 delivery.status:'waiting' 这个条件，MongoDB 串行执行，
//   第二个人的更新命中 0 条，就知道自己没抢到。
//   现在只有一个配送员，看起来是多余的 —— 但它是「以后加人时不用改」的那部分。
async function acceptDelivery(openid, orderId) {
  if (!isAdmin(openid)) return { code: 1, message: '你不是配送员' };
  if (!orderId) return { code: 1, message: '缺少订单 ID' };

  // 先读一次订单，拿商品价格快照。
  //
  // 【为什么不在 update 里现算】
  //   这次的更新是条件更新（CAS），data 里只能写死值，读不到文档自己的
  //   goods.price。而这个价必须来自【订单里冻结的快照】，不是商品表里的
  //   当前价 —— 卖家事后改价，不该让已经下过的单改配送费。
  //
  // 【为什么下单时算过一次，这里还要再算】
  //   下单时那次是给【显示】用的：池子卡片和下单页都得在这单还没人接的
  //   时候就有数。这次才是给【记账】用的。两次调的是同一个 sizeByPrice、
  //   喂进去的是同一个快照价，结果必然一致。
  //   顺带把这份改动之前创建的老单子兜住 —— 那些单子 size 是空串、
  //   fee 是 0，不重算的话配送员会白跑一趟。
  const doc = await db
    .collection(ORDERS)
    .doc(orderId)
    .get()
    .catch(() => null);
  const order = doc && doc.data;
  if (!order) return { code: 1, message: '订单不存在' };

  const size = sizeByPrice((order.goods || {}).price);
  const fee = DELIVERY_FEE[size];

  const res = await db
    .collection(ORDERS)
    .where({
      _id: orderId,
      status: O_COMPLETED,
      'delivery.status': D_WAITING
    })
    .update({
      data: {
        'delivery.status': D_ACCEPTED,
        'delivery.size': size,
        'delivery.fee': fee,
        'delivery.courierOpenid': openid,
        'delivery.acceptTime': new Date()
      }
    });

  if (!res.stats || res.stats.updated !== 1) {
    return { code: 1, message: '这单已经被接走了' };
  }
  return { code: 0, message: '接单成功', fee };
}

// 送达。
//
// 【钱是线下收的，这里只记账】
//   个人主体小程序拿不到微信支付商户号，所以配送费收不到线上。
//   这一步标记的是「送到了」，同时也就意味着「钱当面收了」。
//   如果货到付款失败（买家不在、说没带钱），别点这个按钮 ——
//   让它停在「配送中」，明天接着送。
async function finishDelivery(openid, orderId) {
  if (!isAdmin(openid)) return { code: 1, message: '你不是配送员' };
  if (!orderId) return { code: 1, message: '缺少订单 ID' };

  const res = await db
    .collection(ORDERS)
    .where({
      _id: orderId,
      'delivery.courierOpenid': openid,
      'delivery.status': D_ACCEPTED
    })
    .update({
      data: {
        'delivery.status': D_DELIVERED,
        'delivery.deliverTime': new Date()
      }
    });

  if (!res.stats || res.stats.updated !== 1) {
    return { code: 1, message: '这单不在配送中，或者不是你的单' };
  }
  return { code: 0, message: '已送达' };
}

// 累计配送收入。
//
// 用聚合而不是「拉回列表前端 reduce」，是因为前端那种算法有个上限：
// 为了不把几百条订单一次拉回来，前面的查询都带着 limit(100)，
// 于是第 101 单之后的收入就悄悄不算了 —— 数字看着还在涨，
// 涨到某个点就停住，而且不报错。这种「结果悄悄变错」最难发现。
// 服务端聚合由数据库求和，多少单都不会漏。
async function deliveryIncome(openid) {
  if (!isAdmin(openid)) return { code: 1, message: '你不是配送员' };

  const $ = db.command.aggregate;
  const res = await db
    .collection(ORDERS)
    .aggregate()
    .match({ 'delivery.courierOpenid': openid, 'delivery.status': D_DELIVERED })
    // _id: null 的意思是「不分组的全局汇总」——
    // group 必须先给一个分组键，不想分组也得写 null 占位
    .group({ _id: null, total: $.sum('$delivery.fee'), count: $.sum(1) })
    .end();

  const row = (res.list && res.list[0]) || {};
  return {
    code: 0,
    message: 'ok',
    total: row.total || 0, // 一共赚了多少元
    count: row.count || 0 // 一共送了多少单
  };
}

exports.main = async (event) => {
  // ===== 定时触发器的分流，必须在最前面 =====
  //
  // 定时器调云函数时，event 长这样：
  //   { Type: 'Timer', TriggerName: 'autoCloseExpiredOrders', Time: '...' }
  // 它没有 action，也【没有微信登录态】—— 后面 cloud.getWXContext() 拿到的
  // OPENID 会是空的。所以必须在这里就拐走，否则会掉进 default 分支被当成
  // 「不支持的操作」。
  // 【V-02 修复】放行条件从「Type 字段等于 Timer」改成「平台来源 + 显式开关」。
  //
  // 旧代码：if (event && event.Type === 'Timer') 就执行全量超时清理。
  //   Type 是【客户端可以任意构造】的 data 字段，任意用户执行
  //     callFunction({ name: 'order', data: { Type: 'Timer' } })
  //   就能以管理员权限批量改写他人订单状态、发订阅消息，
  //   没有登录态校验、没有身份校验，还能反复调用。
  //
  // 新判据是两条【客户端造不出来】的证据：
  //   ① OPENID 为空 —— 定时触发没有微信登录态，而客户端调用
  //      一定会带上调用者的 OPENID。这一条由 getWXContext 决定，
  //      不由 event 决定，是这里最硬的一道；
  //   ② TriggerName 与平台注入的触发器名一致 —— 同样是平台侧的值。
  //   两条同时成立才认为是平台来源；本地调试另开 ALLOW_MANUAL_TIMER
  //   （默认 false，要开必须改代码重新部署，而不是改请求参数）。
  if (event && event.Type === 'Timer') {
    const { OPENID: timerCallerOpenid } = cloud.getWXContext();
    const fromPlatform =
      !timerCallerOpenid && event.TriggerName === TIMER_TRIGGER_NAME;

    if (!fromPlatform && !ALLOW_MANUAL_TIMER) {
      console.warn(
        '[order] 拒绝了一次非平台来源的 Timer 调用，caller=',
        timerCallerOpenid || '(无登录态但 TriggerName 不匹配)'
      );
      return { code: 403, message: '该操作不可手动触发' };
    }

    try {
      return await autoCloseExpired(EXPIRE_HOURS);
    } catch (err) {
      console.error('autoCloseExpired error:', err);
      return { code: -1, message: '超时清理失败：' + err.message };
    }
  }

  const { OPENID } = cloud.getWXContext();
  const action = (event && event.action) || '';

  try {
    switch (action) {
      case 'create':
        return await create(
          OPENID,
          event.goodsId,
          event.deliveryType,
          event.addressId
        );
      case 'confirm':
        return await confirm(OPENID, event.orderId, event.sellerPhone);
      case 'reject':
        return await closeOrder(OPENID, event.orderId, '卖家拒绝了这笔订单');
      case 'cancel':
        return await closeOrder(OPENID, event.orderId, '买家取消了订单');
      case 'listMine':
        return await listMine(OPENID);
      case 'listReceived':
        return await listReceived(OPENID);

      // 「我是谁」。前端用它判断要不要显示「配送管理」入口。
      //
      // 【为什么不把这个判断塞进 user 云函数】
      //   那样白名单就要写两份（云函数之间 require 不到），
      //   而这份名单是【权限】不是文案 —— 两份名单迟早会不一致，
      //   到时候「菜单看得到但点进去说你权限不够」这种鬼状态就来了。
      //   宁可让「我的」页面多一次云调用，也要让权限只有一处定义。
      //
      // 这个 action 故意【不】要求 isAdmin：它本来就是用来发现
      // 「我到底是不是」的。返回自己的 openid 也不泄露什么。
      case 'whoami':
        return {
          code: 0,
          message: 'ok',
          openid: OPENID,
          isAdmin: isAdmin(OPENID),
          // 白名单里有几个人。
          //
          // 前端那一屏靠它区分「名单是空的」和「名单里有人、但字符串没对上」——
          // 这两种情况要做的事完全不同（一个是重新部署，一个是改字符串），
          // 分不出来的话就要在两者之间白跑一个来回。
          //
          // 只报【个数】不报内容：谁是配送员不是公开信息。
          adminCount: ADMIN_OPENIDS.length,
          version: CODE_VERSION
        };

      case 'deliveryPool':
        return await deliveryPool(OPENID);
      case 'myDeliveries':
        return await myDeliveries(OPENID);
      case 'acceptDelivery':
        return await acceptDelivery(OPENID, event.orderId);
      case 'finishDelivery':
        return await finishDelivery(OPENID, event.orderId);
      case 'deliveryIncome':
        return await deliveryIncome(OPENID);

      default:
        return {
          code: 1,
          message: '不支持的操作：' + action + '（云端版本 v' + CODE_VERSION + '）'
        };
    }
  } catch (err) {
    console.error('order error:', action, err);
    return { code: -1, message: '操作失败：' + err.message };
  }
};
