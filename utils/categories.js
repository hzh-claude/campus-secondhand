// utils/categories.js
// 商品分类的【唯一来源】。
//
// 【为什么要有这个文件】
//   以前分类列表在 pages/home/home.js 和 pages/push/push.js 里各写了一份，
//   靠注释互相提醒「两边要一致」。那份提醒是有用的 —— 它确实拦下过一次：
//   「其他」先加进了 push.js，首页漏了，于是「其他」下的商品首页点不进去
//   （商品还在商品流里飘着、详情也打得开，但没有任何分类入口能找到它）。
//
//   靠人记住两处要一起改，迟早还会再漏一次。现在两份合成一份：
//   加分类、改名字、改量词，都只改这个文件。
//
// ⚠️ 页面里不要再自己拼一份分类数组。要么直接引用 CATEGORIES，
//    要么用 map 从它派生出自己的形状 —— push.js 的 { text, value } 就是这么来的。
//
// ⚠️ 这里的 name 会被【原样写进商品的 category 字段】，并被 type_list
//    用 where.category = 名字 精确匹配查询。所以改 name 等于让所有老商品
//    瞬间查不出来 —— 真要改名，得连带迁移数据库里的存量值。

const CATEGORIES = [
  { id: 1, name: '图书教材', icon: 'bookmark-o', unit: '本' },
  { id: 2, name: '数码产品', icon: 'phone-o', unit: '件' },
  { id: 3, name: '生活用品', icon: 'home-o', unit: '个' },
  // 「其他」是兜底分类，不是第四个正经分类。
  // 它的意义是：卖不出去的东西以前只能硬塞进最接近的那个分类，
  // 于是「生活用品」里混着奇奇怪怪的东西，分类筛选也就失真了。
  // 留一个诚实的口子，前三个分类反而更准。
  // 量词用「个」：兜底分类什么都有，没有比「个」更合适的。
  { id: 4, name: '其他', icon: 'more-o', unit: '个' }
];

// 分类对不上时用的量词。
// 宁可显示「3 个」，也不要显示「3 undefined」—— 后者会被当成页面坏了。
const UNIT_DEFAULT = '个';

// 某个分类的量词（本 / 件 / 个）。
// 传进来的可能是空字符串（用户还没选分类），一律落到 UNIT_DEFAULT。
function unitOf(categoryName) {
  const name = String(categoryName == null ? '' : categoryName);
  const hit = CATEGORIES.filter((c) => c.name === name)[0];
  return (hit && hit.unit) || UNIT_DEFAULT;
}

// ============================================================
// 数量
// ============================================================
//
// 发布时填的「这件东西我有几个」。
//
// 【它不参与下单，也不做库存扣减】
//   现在的下单流程是「一口价买走这一条」，买家没有选数量的地方，
//   订单里也没有数量字段。所以这个数只是【卖家写给买家看的说明】。
//   商品一旦被卖出就是整体 sold，数字不会从 3 变成 2。
//
//   要真做成库存，得动下单页、订单结构、以及订单完成时的扣减 —— 是另一个工程。
//   知道这个边界很重要：否则会以为「卖出一件后数量该少 1」，
//   发现它没少，然后当成 bug 去查。

const QUANTITY_MAX = 999;

// 最多几位数字，从上限推出来 —— 改 QUANTITY_MAX 时不用再记得改这里
const QUANTITY_DIGITS = String(QUANTITY_MAX).length;

// 边输边清洗：只留数字、去掉前导零、最多 QUANTITY_DIGITS 位。
//
// 和 utils/util.js 的 sanitizePriceInput 同一个套路：
// type="number" 只保证弹出来的键盘长得对，不保证用户敲出来的东西合法
// （可以粘进来一串带字母的文本）。
function sanitizeQuantityInput(value) {
  const raw = String(value == null ? '' : value);
  let digits = raw.replace(/[^\d]/g, '');

  // 去掉前导零：「007」显示成 7。
  // (?=\d) 是为了让单独的一个「0」原样留着 —— 少了它，
  // 用户刚敲下 0 就被抹成空字符串，光标会莫名跳回最前面。
  digits = digits.replace(/^0+(?=\d)/, '');

  if (digits.length > QUANTITY_DIGITS) digits = digits.slice(0, QUANTITY_DIGITS);
  return digits;
}

// 提交前的校验。
//
// 这是【前端】那道，负责早点给出人话提示；真正拦得住的是
// publishGoods / manageGoods 里的同一套判断 —— 那两份才是安全边界。
// 上下限两处必须一致，搜索 QUANTITY_MAX 能同时找到这三个地方。
function isValidQuantity(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= QUANTITY_MAX;
}

module.exports = {
  CATEGORIES,
  UNIT_DEFAULT,
  unitOf,
  QUANTITY_MAX,
  sanitizeQuantityInput,
  isValidQuantity
};
