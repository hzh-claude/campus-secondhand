// utils/util.js
// 公共小工具
//
// 这里原来有一份小程序模板自带的 formatTime，但它有个坑：
// 它直接调用 date.getFullYear()，也就是【必须传 Date 对象】。
// 而从云数据库读回来的 createTime 是 ISO 字符串，传进去会得到 "NaN/NaN/NaN NaN:NaN:NaN"。
// 结果就是每个页面都自己复制了一份能处理字符串的版本 —— detail / my_sold / my_push
// 三份一模一样的代码。所以这里把它重写成能接受多种入参的版本，三份副本全部删掉。

// 金额相关的三个函数要用到售价上限。
// cloud-config.js 是纯常量文件、不 require 任何东西，所以这里不会出现循环依赖。
const { PRICE_MAX, PRICE_DECIMALS } = require('./cloud-config');

function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

// 格式化成「2024-01-10 14:30」
// 入参可以是 Date、时间戳、ISO 字符串；无效值返回 ''（而不是 NaN 字符串）
function formatTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d.getTime())) return '';
  return (
    d.getFullYear() +
    '-' +
    pad(d.getMonth() + 1) +
    '-' +
    pad(d.getDate()) +
    ' ' +
    pad(d.getHours()) +
    ':' +
    pad(d.getMinutes())
  );
}

// 聊天场景专用的时间格式。
//
// 为什么不直接用 formatTime：聊天列表里每条后面要跟一个时间，
// 满屏「2026-09-27 14:30」又长又难扫。人对时间的精度需求是
// 随距离衰减的 —— 刚刚发生的只关心几点几分，上周的只关心哪天。
//   今天   → 14:30
//   昨天   → 昨天
//   今年内 → 09-27
//   跨年   → 2025-09-27
//
// 「昨天」不能靠「now - 24小时」算。22:00 发的消息，第二天早上 8 点看，
// 只差 10 小时，但它确实是昨天发的；而 24 小时前这一刻可能是前天。
// 必须拿【日历天】比，所以要把两个时间都归零到当天 00:00 再算差。
function formatChatTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d.getTime())) return '';

  const now = new Date();
  const dayDiff = calendarDayDiff(d, now);

  if (dayDiff === 0) return pad(d.getHours()) + ':' + pad(d.getMinutes());
  if (dayDiff === 1) return '昨天';
  if (d.getFullYear() === now.getFullYear()) {
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

// 求「日历天」差：d 是 now 之前几天。
//
// 为什么不能直接拿 (now - d) / 86400000 算：
//   22:00 发的消息，第二天早上 8 点看，只差 10 小时 —— 按【时长】它
//   还不到一天，但按【日历】它确实是昨天发的。
//   反过来，「整 24 小时前」这一刻也可能已经落到前天。
//   聊天里的「今天 / 昨天」是日历概念，不是时长概念，
//   所以必须把两个时间都归零到各自当天的 00:00 再求差。
//
// 【为什么抽成函数】这段推理原来在 formatChatTime 和聊天页气泡里
// 各写了一遍。两处都写了注释解释同一个坑 —— 那就意味着这个坑
// 有两份，改对一处、漏掉另一处，就会出现「列表说今天、气泡说昨天」。
function calendarDayDiff(d, now) {
  const a = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const b = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((a - b) / 86400000);
}

// 聊天页气泡下面的时间：日期 + 时分。
//
// 【原来这里只有「时:分」】（叫 formatClock），后果是翻聊天记录时
// 满屏 14:30 / 14:31，从头到尾【没有一个字告诉你是哪天】——
// 三天前聊的和今天聊的长得一模一样，只能靠往上翻到底来猜。
//
// 现在按「人对时间的精度需求随距离衰减」来给：
//   今天   → 14:30
//   昨天   → 昨天 14:30
//   今年内 → 09-27 14:30
//   跨年   → 2025-09-27 14:30
//
// 今天【故意不写日期】：打开聊天页默认停在最新处，当天消息占绝大多数，
// 每条都挂个「09-27」纯属噪音 —— 人对自己刚说过的话不需要日期。
// 非今天的【必须】写，那才是「看不出是哪天」真正出问题的地方。
//
// 注意这个值是在【消息加载时】算一次、存进 timeText 的。
// 页面跨过午夜一直开着不动的话，昨天的消息还会显示「14:30」。
// 不专门处理：聊天页会持续轮询、重进也会重算，而为一个
// 需要盯着屏幕跨零点的场景加一套定时重算是得不偿失。
function formatMsgTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d.getTime())) return '';

  const clock = pad(d.getHours()) + ':' + pad(d.getMinutes());

  const now = new Date();
  const dayDiff = calendarDayDiff(d, now);

  if (dayDiff === 0) return clock;
  if (dayDiff === 1) return '昨天 ' + clock;
  if (d.getFullYear() === now.getFullYear()) {
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + clock;
  }
  return (
    d.getFullYear() +
    '-' +
    pad(d.getMonth() + 1) +
    '-' +
    pad(d.getDate()) +
    ' ' +
    clock
  );
}

// ============================================================
// 金额
// ============================================================

// 把商品价格渲染成给用户看的一串字符。
//
// 【为什么需要一个函数，而不是直接 {{price}}】
//    price 在库里是 Number。绝大多数数字 String() 出来就是正常的，
//    但双精度浮点数在绝对值 >= 1e21 时会切换成科学计数法 ——
//    String(1e25) === '1e+25'，页面上就会出现「¥1e+25」。
//    这不是排版问题，是用户根本读不出这是多少钱。
//
//    注意 toFixed 救不了这个场景：(1e25).toFixed(2) 同样返回 '1e+25'，
//    toFixed 只在 < 1e21 时才展开成定点记法。所以必须【先拦掉超限值】，
//    不能指望 toFixed 兜底。
//
// 【超上限的显示成 '9999+'】
//    这是历史脏数据（上限规则上线之前存的），真实值可能是 1e25，
//    也可能是用户乱按的 999999。显示成一个具体数字就是撒谎，
//    而 '9999+' 是在说「比上限还大」—— 既不暴露一个读不出来的数，
//    也不假装它是个正常价格。
//    配合 createOrder 里的价格判断，这种商品是【下不了单】的，
//    所以不存在「看了 ¥9999+ 就当成 ¥9999 买走」的风险。
function formatPrice(value) {
  const n = Number(value);
  // 先判 NaN 和 <= 0：NaN 参与任何比较都是 false，不能靠下面那条 < 判断兜住它
  if (Number.isNaN(n) || n <= 0) return '0';
  // 再判超限。放在 isFinite 之前是有意的：Infinity 也该显示成「超上限」，
  // 而不是掉进「这不是个数字」的分支 —— 它确实比上限大。
  if (n > PRICE_MAX) return PRICE_MAX + '+';

  // 这里 n 已经保证 < 1e21，toFixed 是安全的
  const fixed = n.toFixed(PRICE_DECIMALS);
  // 砍掉无意义的尾随 0：12.50 → 12.5，12.00 → 12
  return fixed.replace(/\.?0+$/, '');
}

// 判断一个价格能不能成交（下单、发布、编辑都要用同一套判断）
//
// ⚠️ 这是【前端】的版本，只负责早点给出提示。
//    真正拦得住的是云函数里的那份，两边的判断必须一模一样 ——
//    搜索 PRICE_MAX 能找到所有需要同步修改的地方。
function isValidPrice(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= PRICE_MAX;
}

// 清洗价格输入框里的字符，返回「用户真正应该看到的那串」。
//
// 数字键盘（van-field type="digit"）只保证弹出的键盘长得对，
// 不保证用户按出来的东西合法：可以连按两个小数点（12..5）、
// 可以按住 9 不放（99999999999）、可以以小数点开头（.5）。
// 这个函数把这些都折叠成合法输入，边输边纠正。
//
// 允许的形态：整数部分最多和 PRICE_MAX 一样长，小数最多 PRICE_DECIMALS 位。
function sanitizePriceInput(raw) {
  // 1. 只留数字和小数点（中文输入法、粘贴都可能带进别的字符）
  let s = String(raw == null ? '' : raw).replace(/[^0-9.]/g, '');
  if (!s) return '';

  // 2. 只保留第一个小数点，后面的全丢掉
  const firstDot = s.indexOf('.');
  if (firstDot !== -1) {
    s = s.slice(0, firstDot + 1) + s.slice(firstDot + 1).replace(/\./g, '');
  }

  // 3. 拆成整数/小数两段分别截断
  const parts = s.split('.');
  const intPart = (parts[0] || '').slice(0, String(PRICE_MAX).length);
  const hasDot = parts.length > 1;
  const decPart = (parts[1] || '').slice(0, PRICE_DECIMALS);

  // 4. 整数部分为空但用户敲了小数点（".5"）→ 补成 "0.5"，
  //    否则这个字符串会被当成非法输入，用户以为自己没输错却发不出去
  if (hasDot) {
    return (intPart || '0') + '.' + decPart;
  }
  return intPart;
}

module.exports = {
  formatTime,
  formatChatTime,
  formatMsgTime,
  formatPrice,
  isValidPrice,
  sanitizePriceInput
};
