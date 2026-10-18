// utils/campus.js
// 交易地点的【唯一来源】：园区 → 楼栋。
//
// 【它和用户档案里的「宿舍」不是一回事】
//   users.campus / address.campus 表示「我住在哪儿」，只有四个园区、不带楼栋，
//   而且【不应该】跟着这个文件变（见 pages/edit、pages/address_edit）。
//   商品上的 campus 表示「在哪儿面交/取货」，现在要精确到楼栋。
//   两个概念共用 campus 这个字段名是历史遗留，靠界面上的措辞区分：
//   档案里叫「宿舍」，商品上叫「交易地点」。
//
// ============================================================
// 存进数据库的是什么
// ============================================================
//
// 商品的 campus 字段存的是【显示用的整串】：
//
//     竹园          ← 竹园只有一栋，不细分
//     松园·松一      ← 园区 + 楼栋，中间那个点是 CAMPUS_SEP
//
// 【为什么不拆成 campus + campusBuilding 两个字段】
//   存整串的好处是【所有显示的地方一个字都不用改】——
//   首页卡片、搜索页、卖家主页、详情页、订单里的商品快照，
//   读的都是 item.campus，存了整串它们直接就能显示出「松园·松一」。
//   拆成两个字段的话，上面每一处都要改成拼接，改漏一处就少显示一截，
//   而且漏的那处不会报错，只会静静地少半截字。
//
// 【代价：按园区筛选要枚举】
//   老数据存的是「松园」（没有楼栋），新数据是「松园·松一」。
//   所以「筛出松园的所有商品」不能写成 where.campus = '松园'
//   （那样新数据一条都筛不到），要写成
//   where.campus in ['松园', '松园·松一', '松园·松二', …]。
//   这张表由 campusFilterValues 生成，把只有园区名的老值也包进去。
//   pages/type_list 用的就是它。
//
// ⚠️ 云函数那边做前缀校验用的是另一份园区名列表（云函数 require 不到 utils），
//    搜索 CAMPUS_ROOTS 能同时找到这几个地方。加园区要一起加。

const CAMPUS_SEP = '·';

const CAMPUS_GROUPS = [
  { name: '荷园', buildings: ['荷一', '荷二', '荷三', '荷四', '荷五', '荷六', '荷七'] },
  { name: '松园', buildings: ['松一', '松二', '松三', '松四', '松五'] },
  { name: '桃园', buildings: ['桃一', '桃二', '桃三', '桃四', '桃五', '桃六', '桃七'] },
  // 竹园只有一栋，没有楼栋可选。空数组【不是】忘了填 ——
  // 发布页看到空数组会显示「只有一栋，不用再选」，而不是给一片空白。
  { name: '竹园', buildings: [] }
];

// 四个园区名。云函数端各有一份同名的（见上面的 ⚠️）。
const CAMPUS_ROOTS = CAMPUS_GROUPS.map((g) => g.name);

// 档案/地址里「宿舍」选择器的选项。
//
// 【为什么由这里生成，而不是各页面各写一份】
//   注册页、编辑资料页、地址编辑页原来各自写了一遍四个园区的字面量 ——
//   三份一模一样的数组，散在三个文件里。对原开发者来说那只是重复；
//   对【接手这份代码的人】来说那是三个必须同时改的地方，
//   而漏改的那一页不会报错，只会在选择器里露出别人学校的宿舍名。
//   换学校是这份代码最常做的一次改造，所以把这份列表收到这里。
//
//   Vant Weapp 1.10+ 的 picker 只认 { text, value } 对象数组，
//   传纯字符串数组会渲染不出选项 —— 所以在这里 map 一次。
const CAMPUS_OPTIONS = CAMPUS_ROOTS.map((name) => ({ text: name, value: name }));

// 拼出存库/显示的那一整串
function buildCampus(group, building) {
  if (!group) return '';
  return building ? group + CAMPUS_SEP + building : group;
}

// 反过来拆开。编辑商品时要把存着的「松园·松一」还原成选择器的两个状态。
//
// 老数据的「松园」拆出来是 { group: '松园', building: '' } —— 楼栋留空，
// 让卖家自己补一个，而不是替他猜一个。
function parseCampus(value) {
  const raw = String(value == null ? '' : value);
  if (!raw) return { group: '', building: '' };

  const idx = raw.indexOf(CAMPUS_SEP);
  if (idx < 0) return { group: raw, building: '' };

  return {
    group: raw.slice(0, idx),
    building: raw.slice(idx + CAMPUS_SEP.length)
  };
}

// 某个园区在数据库里【可能出现过】的所有值，含只有园区名的老数据。
// 给 where(_.in(...)) 用。
function campusFilterValues(groupName) {
  const name = String(groupName == null ? '' : groupName);
  const hit = CAMPUS_GROUPS.filter((g) => g.name === name)[0];

  // 传进来一个不在表里的值（正常不会）：原样返回。
  // 返回空数组会让 where(_.in([])) 变成「查不到任何东西」，
  // 那比查错更难判断 —— 界面上看起来就是「这个园区一件商品都没有」。
  if (!hit) return [name];

  return [hit.name].concat(hit.buildings.map((b) => buildCampus(hit.name, b)));
}

module.exports = {
  CAMPUS_SEP,
  CAMPUS_GROUPS,
  CAMPUS_ROOTS,
  CAMPUS_OPTIONS,
  buildCampus,
  parseCampus,
  campusFilterValues
};
