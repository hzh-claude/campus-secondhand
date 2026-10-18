// cloudfunctions/manageGoods/index.js
// 商品管理：我的发布列表 / 浏览量自增 / 下架 / 重新上架 / 编辑 / 删除
// 所有写操作都会先校验商品归属（_openid === 调用者）
//
// 【这里为什么没有 verified 核验门 —— 想过了，故意不加】
//   publishGoods 里有 requireVerified（发布必须已核验），这里是唯一
//   没有那道门的商品写入口。看着像漏了，其实不构成缺口：
//   一个账号能出现在这里，前提是它【名下已经有商品】，而商品只能通过
//   publishGoods 创建 —— 那道门早就在前面拦过一次了。
//   所以「编辑/下架/删除」的可达集合，是「发布」的可达集合的子集。
//
//   反过来说，如果哪天出现第二条创建商品的路径（导入、复制、后台代发），
//   这条推理立刻失效，那时候必须在这里补上核验门。
//
//   归位校验（getOwnGoods）是另一回事，每个写操作都有，不能省 ——
//   它管的是「这是不是你的商品」，和「你有没有资格交易」无关。
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const GOODS = 'goods';
const ORDERS = 'orders';
const MAX_TEXT_LEN = 2500;

// 商品描述 / 成色说明的字数上限。
//
// ⚠️ 必须和 cloudfunctions/publishGoods/index.js 里的同名常量一致，
//    也要和 pages/push/push.wxml 那个 textarea 的 maxlength="200" 一致。
//    三条路（新建 / 编辑 / 前端）只要有一条漏了，就等于没拦。
//
// 【为什么要在这里再写一份】云函数是独立部署的，require 不到 utils 和彼此。
// 【为什么这条不能省】不加的话，送检的串（checkContent 里 slice 了 2500）
//   和落库的串就不是同一个 —— 详见 publishGoods 里 DESC_MAX 那段说明。
const DESC_MAX = 200;
const CONDITION_MAX = 20;

// 售价上限与小数位。
//
// ⚠️ 必须和 utils/cloud-config.js、cloudfunctions/publishGoods/index.js 里的同名常量一致！
//    云函数是独立部署的，require 不到 utils，只能各写一份。
//    搜索 PRICE_MAX 能同时找到这三个地方。
//
// 【编辑这条路尤其不能漏】
//    只改发布、不改编辑，等于「发布时拦得住、编辑时能绕过去」——
//    用户发一个 ¥5 的商品，再编辑成 999999，上限就白设了。
const PRICE_MAX = 9999;
const PRICE_DECIMALS = 2;

// 价格校验。返回 null 表示合法，否则返回给用户的错误文案。
// 和 utils/util.js 的 isValidPrice 是同一个判断，改的时候一起改。
function checkPrice(price) {
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0) return '请输入正确的商品价格';
  if (n > PRICE_MAX) return '售价不能超过 ¥' + PRICE_MAX;
  // 小数位。用 Number 比较会踩浮点误差（1.005 * 100 是 100.49999…），
  // 所以拿字符串数小数点后面的位数。
  const dot = String(price).indexOf('.');
  const decimals = dot === -1 ? 0 : String(price).length - dot - 1;
  if (decimals > PRICE_DECIMALS) return '售价最多保留 ' + PRICE_DECIMALS + ' 位小数';
  return null;
}

// 出售数量。
//
// ⚠️ 必须和 utils/categories.js、cloudfunctions/publishGoods/index.js
//    里的同名常量一致！搜索 QUANTITY_MAX 能同时找到这三个地方。
//
// 【和价格一样，编辑这条路不能漏】
//    只改发布不改编辑，等于「发布时是 1-999、编辑时能写成 -5 或 1e25」。
const QUANTITY_MAX = 999;
const QUANTITY_DEFAULT = 1;

// 数量缺省值。
//
// 【为什么缺省而不是必填】
//   必填的后果是：云函数先部署、小程序还没跟着改的时候，
//   旧前端一个商品都发不出去，报错还是「数量必须是 1-999 之间的整数」——
//   而它根本没传过这个字段，看到这句话完全不知道该改什么。
//   数量又不像价格那样涉及钱，缺了按 1 算不会造成任何损失。
//   所以「没传」放行，「传了个不合法的」照样拒绝。
function normalizeQuantity(raw) {
  if (raw === undefined || raw === null || raw === '') return QUANTITY_DEFAULT;
  return Number(raw);
}

// 数量校验。返回 null 表示合法，否则返回给用户的错误文案。
// 用 Number.isInteger 而不是只比大小：1.5 个商品没有意义，
// 而 1.5 是能通过 n >= 1 && n <= 999 的。
function checkQuantity(quantity) {
  const n = Number(quantity);
  if (!Number.isInteger(n) || n < 1 || n > QUANTITY_MAX) {
    return '数量必须是 1-' + QUANTITY_MAX + ' 之间的整数';
  }
  return null;
}

// 交易地点的合法园区。
//
// ⚠️ 必须和 utils/campus.js 的 CAMPUS_ROOTS 一致！
//    云函数 require 不到 utils，只能各写一份。
//    搜索 CAMPUS_ROOTS 能同时找到这几个地方。
//
// 【为什么只校验前缀，不列全 20 个楼栋】
//   商品的 campus 存的是整串（「松园·松一」），合法值有 20 个。
//   把那 20 个字符串在这儿再抄一遍，等于给「以后加一栋楼要改三个文件」埋雷。
//   而 campus 最终只是显示给买家看的一行字，不参与任何判断 ——
//   卡住「必须以某个园区名开头」就够了。
const CAMPUS_ROOTS = ['荷园', '松园', '桃园', '竹园'];

function isTradeCampus(campus) {
  return CAMPUS_ROOTS.some((root) => campus.indexOf(root) === 0);
}

// 关闭某个商品上所有待确认的订单，返回关闭了几笔。
//
// 这里是 manageGoods 直接操作 orders 集合，而不是去调用 order 云函数 ——
// 云函数之间互调需要额外配置，而且这事就是一次按条件的批量更新，
// 没必要绕一圈。【云函数可以读写任意集合，不限于自己「负责」的那张表。】
async function closePendingOrders(goodsId, reason, now) {
  const res = await db
    .collection(ORDERS)
    .where({ goodsId, status: 'pending' })
    .update({
      data: { status: 'cancelled', cancelReason: reason, finishTime: now }
    });
  return (res && res.stats && res.stats.updated) || 0;
}

// 这件商品有没有已经成交的订单。
// undoSold 用它区分「快捷卖出点错了」和「买家下单后卖家确认过」。
async function hasCompletedOrder(goodsId) {
  const res = await db
    .collection(ORDERS)
    .where({ goodsId, status: 'completed' })
    .limit(1)
    .count();
  return (res.total || 0) > 0;
}

// 部署版本号：每次改动 +1。
// 「不支持的操作：xxx」这个报错九成是云函数没部署成功、云端还跑着旧代码。
// 把版本号带在报错里，一眼就能确认云端到底是哪个版本，不用再猜。
// 商品图片的云存储目录前缀。
//
// ⚠️ 必须和 utils/cloud-config.js 的 CLOUD_PATH.GOODS_IMAGE 一致！
//    云函数 require 不到 utils 目录，只能各写一份。搜索 GOODS_IMAGE 能找到三处。
//
// 【为什么服务端也要拥有一份】
//    客户端上传时的 cloudPath 是客户端自己拼的，理论上可以指向任意目录。
//    「按目录区分用途」这件事只有服务端也认这份约定，才真的成立。
const GOODS_IMAGE_PREFIX = 'goods/';

// 当前云环境 ID（缓存一次，避免每次都走 getWXContext）。
// 取不到时返回空串，校验逻辑自动降级为「只判目录前缀」——
// 跨环境的 fileID 在当前环境本来就删不掉，降级不会放大风险。
let CACHED_ENV_ID = '';
function currentEnvId() {
  if (!CACHED_ENV_ID) {
    try {
      const ctx = cloud.getWXContext() || {};
      CACHED_ENV_ID = ctx.ENV || '';
    } catch (err) {
      CACHED_ENV_ID = '';
    }
  }
  return CACHED_ENV_ID;
}

// 解析商品图 fileID，失败返回 null。
function parseGoodsImage(fileID) {
  if (typeof fileID !== 'string') return null;
  const id = fileID.trim();
  if (!id) return null;

  const m = /^cloud:\/\/([^/]+)\/(.+)$/.exec(id);
  if (!m) return null;

  // 【跨环境判断 —— 和 publishGoods 里的同名校验是同一条，改一处必须改两处】
  //
  //   m[1] 是「<环境ID>.<存储桶>」（见 chat/index.js 的说明），
  //   而 currentEnvId() 给的是【纯环境 ID】。原来那句 `m[1] !== envId`
  //   拿「cloud1-xxxx.636c-cloud1-xxxx-1300xxxxxx」去比「cloud1-xxxx」，
  //   永远不相等 —— 所有图片都会被判成"别的环境"，编辑商品时
  //   保存下来的图会被整批丢掉。
  //   带不带存储桶段两种形状都认，避免误杀。
  const envId = currentEnvId();
  if (envId && m[1] !== envId && m[1].indexOf(envId + '.') !== 0) return null;

  const path = m[2];
  if (path.indexOf('..') !== -1) return null;
  return { id, path };
}

// 本环境 goods/ 目录（含历史上没有 openid 层的旧图）。
function isInGoodsDir(fileID) {
  const parsed = parseGoodsImage(fileID);
  if (!parsed) return false;
  return (
    parsed.path.indexOf(GOODS_IMAGE_PREFIX) === 0 ||
    parsed.path.indexOf('/' + GOODS_IMAGE_PREFIX) >= 0
  );
}

// 调用者自己目录下的新图：goods/<openid>/
function isOwnGoodsImage(fileID, openid) {
  if (!openid) return false;
  const parsed = parseGoodsImage(fileID);
  if (!parsed) return false;
  const prefix = GOODS_IMAGE_PREFIX + openid + '/';
  return parsed.path.indexOf(prefix) === 0 || parsed.path.indexOf('/' + prefix) >= 0;
}

// 编辑时允许保留的图：自己新上传的，或这件商品上已经有的旧 goods/ 图。
// 别人的 fileID 不在这件商品的 images 里，加不进来。
function canKeepGoodsImage(fileID, openid, existingList) {
  if (isOwnGoodsImage(fileID, openid)) return true;
  const existing = existingList || [];
  return existing.indexOf(fileID) >= 0 && isInGoodsDir(fileID);
}

// 部署版本号：每次改动 +1。
const CODE_VERSION = 10;

// 内容安全检测：pass 放行，review / risky 拒绝；接口异常一律拒绝（绝不放行）
async function checkContent(content) {
  const text = String(content || '').slice(0, MAX_TEXT_LEN);
  if (!text.trim()) return { pass: true };

  const { OPENID } = cloud.getWXContext();
  try {
    const res = await cloud.openapi.security.msgSecCheck({
      version: 2,
      scene: 2,
      openid: OPENID,
      content: text
    });
    const suggest = res && res.result && res.result.suggest;
    if (suggest === 'pass') return { pass: true };
    return {
      pass: false,
      code: 87014,
      message:
        suggest === 'review'
          ? '内容需要人工复核，请调整措辞后重试'
          : '内容涉嫌违规，请修改后重试'
    };
  } catch (err) {
    if (err && err.errCode === 87014) {
      return { pass: false, code: 87014, message: '内容涉嫌违规，请修改后重试' };
    }
    console.error('msgSecCheck error:', err);
    return { pass: false, code: -2, message: '内容安全检测服务异常，请稍后重试' };
  }
}

// 读取商品并校验归属
async function getOwnGoods(id, openid) {
  if (!id) return { ok: false, message: '缺少商品 ID' };
  const res = await db.collection(GOODS).doc(id).get().catch(() => null);
  if (!res || !res.data) return { ok: false, message: '商品不存在或已删除' };
  if (res.data._openid !== openid) {
    return { ok: false, message: '商品不存在或无权限操作' };
  }
  return { ok: true, goods: res.data };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const action = event.action;
  const now = new Date();

  try {
    switch (action) {
      // 我发布的商品
      case 'listMine': {
        const res = await db
          .collection(GOODS)
          .where({ _openid: OPENID })
          .orderBy('createTime', 'desc')
          .limit(100)
          .get();
        return { code: 0, message: 'ok', list: res.data || [] };
      }

      // 浏览量 +1
      case 'incViews': {
        if (!event.id) return { code: 1, message: '缺少商品 ID' };
        await db
          .collection(GOODS)
          .doc(event.id)
          .update({ data: { views: _.inc(1) } });
        return { code: 0, message: 'ok' };
      }

      // 下架。只接受 on_sale → off_sale。
      //
      // 【2026-10-16 修掉的一个洞：这里原来只拦 locked，sold 是放行的】
      //   于是「已卖出的商品」可以走这条路：
      //     sold --offSale--> off_sale --reSale--> on_sale（重新上架）
      //   而 reSale 只要求状态是 off_sale，undoSold 里那道
      //   hasCompletedOrder 守卫【完全没被碰到】——
      //   结果是同一件东西卖给两个人，而系统里两笔单都是合法的。
      //
      //   本来这条路的入口有个 if (status === 'locked') 挡着，
      //   看上去「有做状态校验」，但漏了 sold 这一支 ——
      //   **只拦了自己想到的那个坏状态**，比不拦更危险：
      //   它让人以为这里已经处理过了。
      //
      //   前端按钮只出现在在售列表里，所以正常用户走不到这儿；
      //   但保护「成交不可逆」是服务端的事，不能靠前端不放按钮。
      //
      // ⚠️ 别把下面的条件更新改回「先 if 判断、再无条件 update」：
      //     读和写之间状态会变（确认成交 / 取消订单是并发跑的），
      //     判断必须塞进 where 里，用受影响行数当结果。
      case 'offSale': {
        const own = await getOwnGoods(event.id, OPENID);
        if (!own.ok) return { code: 1, message: own.message };

        // 被买家下单锁定的商品不能直接下架。
        // 否则会出现：买家那边订单还显示「等待卖家确认」，商品却已经不在架上了。
        // 必须先处理那笔订单（确认卖出，或者拒绝掉）。
        if (own.goods.status === 'locked') {
          return { code: 1, message: '该商品已被买家下单，请先处理那笔订单' };
        }
        if (own.goods.status === 'sold') {
          return {
            code: 1,
            message: '已卖出的商品不能下架，如需重新出售请用「撤销卖出」'
          };
        }

        const offRes = await db
          .collection(GOODS)
          .where({ _id: event.id, _openid: OPENID, status: 'on_sale' })
          .update({ data: { status: 'off_sale', updateTime: now } });
        if (!offRes.stats || offRes.stats.updated !== 1) {
          return { code: 1, message: '商品状态已变化，无法下架，请刷新后重试' };
        }
        return { code: 0, message: '下架成功' };
      }

      // 重新上架。只接受 off_sale → on_sale。
      // 前端按钮只出现在「已下架」列表；locked 应走确认/拒绝订单，
      // sold 应走 undoSold。无条件改回 on_sale 会把锁单拆掉，变成一货两卖。
      case 'reSale': {
        const own = await getOwnGoods(event.id, OPENID);
        if (!own.ok) return { code: 1, message: own.message };
        if (own.goods.status !== 'off_sale') {
          return { code: 1, message: '只有已下架的商品才能重新上架' };
        }
        await db
          .collection(GOODS)
          .doc(event.id)
          .update({ data: { status: 'on_sale', updateTime: now } });
        return { code: 0, message: '重新上架成功' };
      }

      // 快捷卖出：线下当面交易完了，卖家直接标记成交，不必让买家线上下单。
      // 有订单流程之后这个入口依然有用 —— 熟人之间一手交钱一手交货，
      // 再让对方掏出手机下一单很别扭。
      case 'markSold': {
        const own = await getOwnGoods(event.id, OPENID);
        if (!own.ok) return { code: 1, message: own.message };
        if (own.goods.status === 'sold') {
          return { code: 1, message: '该商品已经标记为卖出过了' };
        }

        await db
          .collection(GOODS)
          .doc(event.id)
          .update({ data: { status: 'sold', soldTime: now, updateTime: now } });

        // 商品已经线下卖掉了，挂在它上面的待确认订单就悬空了：
        // 买家那边还显示「等待卖家确认」，但东西已经没了。
        // 一并把它们关掉，买家能立刻看到关闭原因，而不是一直傻等。
        const closed = await closePendingOrders(event.id, '卖家已线下卖出', now);

        return {
          code: 0,
          message: closed
            ? '已标记为卖出，并关闭了 ' + closed + ' 笔待确认订单'
            : '已标记为卖出'
        };
      }

      // 撤销卖出（点错了能救回来）
      // 为什么不复用 reSale？reSale 只把 status 改回 on_sale，
      // soldTime 会继续留在记录里成为脏数据。
      // 撤销就该把成交痕迹一并抹掉，用 _.remove() 把字段真正删掉。
      //
      // 【只能撤「快捷卖出」】
      //   markSold 是卖家自己点的、没有买家订单（或只有被关掉的 pending）。
      //   已经有 completed 订单的，是买卖双方成交过的凭证 ——
      //   再改回 on_sale 就是一货两卖。
      case 'undoSold': {
        const own = await getOwnGoods(event.id, OPENID);
        if (!own.ok) return { code: 1, message: own.message };
        if (own.goods.status !== 'sold') {
          return { code: 1, message: '该商品当前不是已卖出状态' };
        }
        if (await hasCompletedOrder(event.id)) {
          return { code: 1, message: '该商品已有成交订单，不能撤销卖出' };
        }
        const undoRes = await db
          .collection(GOODS)
          .where({ _id: event.id, _openid: OPENID, status: 'sold' })
          .update({
            data: { status: 'on_sale', soldTime: _.remove(), updateTime: now }
          });
        if (!undoRes.stats || undoRes.stats.updated !== 1) {
          return { code: 1, message: '商品状态已变化，无法撤销' };
        }
        return { code: 0, message: '已撤销卖出' };
      }

      // 我卖出的商品（按成交时间倒序）
      case 'listSold': {
        const res = await db
          .collection(GOODS)
          .where({ _openid: OPENID, status: 'sold' })
          .orderBy('soldTime', 'desc')
          .limit(100)
          .get();
        return { code: 0, message: 'ok', list: res.data || [] };
      }

      // 编辑商品
      case 'update': {
        const own = await getOwnGoods(event.id, OPENID);
        if (!own.ok) return { code: 1, message: own.message };

        const title = String(event.title || '').trim();
        const description = String(event.description || '').trim();
        const price = Number(event.price);
        // 没传就是 1（老前端），传了就必须合法 —— 见 normalizeQuantity 的说明
        const quantity = normalizeQuantity(event.quantity);
        const category = String(event.category || '').trim();
        const campus = String(event.campus || '').trim();
        // contact 已下线，理由同 publishGoods。
        // 这里【必须和 publishGoods 一起改】—— 只改新建不改编辑，
        // 等于「发布时收不到、编辑时又能写回来」，字段会诈尸。
        const condition = String(event.condition || '').trim();
        // 【V-01 修复】图片只接受「本环境 goods/ 目录」下的云文件。
        //
        // 【为什么是剔除而不是整单拒绝】
        //    和 publishGoods 保持一致：脏值不该进库，但也不必因为
        //    列表里混进一个坏地址就把用户整次编辑打回去 ——
        //    剔除后如果一张都不剩，下面那条判断会兜住并给出提示。
        //
        // 【为什么不能像旧代码那样原样落库】
        //    这个字段将来会被 remove 分支拿去删文件，而那是管理员
        //    权限的删除。入口不洗干净，出口就要出大事：
        //    任何人先把自己的商品 images 写成别人的 fileID，
        //    再点删除，就能借服务端的手删掉别人的文件。
        const rawImages = Array.isArray(event.images)
          ? event.images.slice(0, 9)
          : own.goods.images || [];
        const images = rawImages.filter((id) =>
          canKeepGoodsImage(id, OPENID, own.goods.images || [])
        );

        // 用户明确传了图片、但一条都没通过校验 —— 说明他拿到的是
        // 旧数据或伪造数据，直接告知，而不是把他的商品图清空。
        if (Array.isArray(event.images) && images.length === 0) {
          return { code: 1, message: '商品图片无效，请重新上传' };
        }

        if (!title) return { code: 1, message: '请输入商品标题' };
        if (title.length > 30) return { code: 1, message: '商品标题不能超过30个字' };
        // 和 publishGoods 同一个规则。两边必须一起改 ——
        // 只改新建不改编辑，等于「发布时拦得住、编辑时能绕过去」。
        if (!description) return { code: 1, message: '请填写商品描述' };
        if (description.length > DESC_MAX) {
          return { code: 1, message: '商品描述不能超过' + DESC_MAX + '个字' };
        }
        if (condition.length > CONDITION_MAX) {
          return { code: 1, message: '商品成色说明不能超过' + CONDITION_MAX + '个字' };
        }
        const priceError = checkPrice(price);
        if (priceError) return { code: 1, message: priceError };
        const quantityError = checkQuantity(quantity);
        if (quantityError) return { code: 1, message: quantityError };
        if (!category) return { code: 1, message: '请选择商品分类' };
        if (!campus) return { code: 1, message: '请选择交易地点' };
        if (!isTradeCampus(campus)) {
          return { code: 1, message: '交易地点不在可选范围内' };
        }

        const check = await checkContent([title, description, condition].join('\n'));
        if (!check.pass) return { code: check.code, message: check.message };

        await db
          .collection(GOODS)
          .doc(event.id)
          .update({
            data: {
              title,
              description,
              price,
              quantity,
              category,
              campus,
              condition,
              images,
              'publisher.campus': campus,
              updateTime: now
            }
          });
        return { code: 0, message: '保存成功' };
      }

      // 删除商品（同时清理云存储图片）
      case 'remove': {
        const own = await getOwnGoods(event.id, OPENID);
        if (!own.ok) return { code: 1, message: own.message };

        // 和下架同一道门：locked 必须先处理订单，sold 是成交档案不能删。
        // 只拦在 getOwnGoods 之后不够 —— 读完到 remove 之间状态可能变，
        // 真正删除用带 status 条件的 where，命中 0 条就说明已经不是可删态。
        if (own.goods.status === 'locked') {
          return { code: 1, message: '该商品已被买家下单，请先处理那笔订单' };
        }
        if (own.goods.status === 'sold') {
          return { code: 1, message: '已卖出的商品不能删除' };
        }

        const delRes = await db
          .collection(GOODS)
          .where({
            _id: event.id,
            _openid: OPENID,
            status: _.in(['on_sale', 'off_sale'])
          })
          .remove();
        if (!delRes.stats || delRes.stats.removed !== 1) {
          return { code: 1, message: '商品状态已变化，无法删除' };
        }

        // 【V-01 修复】删除文件前【独立】再走一遍目录白名单。
        //
        // 【入口已经校验过了，为什么出口还要再来一遍】
        //   因为【库里已经躺着的历史数据】不受今天入口校验的约束：
        //   这次修复上线之前，任何人写进 images 的任意 fileID 都
        //   原样存着，今天删一个老商品照样能把别人的文件删掉 ——
        //   而且不可逆，受害者毫无感知。
        //   所以出口这道必须独立成立，不能依赖「入口已经干净了」。
        //   这与 chat / feedback 云函数「删文件前独立校验白名单」
        //   的做法一致：服务端每一次破坏性动作，都要自己判一次。
        const allImages = own.goods.images || [];
        // 只删 goods/<调用者 openid>/ 下的文件。历史上没有 openid 层的旧图
        // 宁可留在存储里，也不要按「在这件商品的 images 里」去删 ——
        // 那会把别人的商品图一并删掉。
        const fileIDs = allImages.filter((id) => isOwnGoodsImage(id, OPENID));
        const skipped = allImages.length - fileIDs.length;
        if (skipped > 0) {
          console.warn(
            '[manageGoods] remove 跳过 ' + skipped +
            ' 个非本人 goods/<openid>/ 目录的文件，goodsId=' + event.id
          );
        }

        if (fileIDs.length > 0) {
          await cloud.deleteFile({ fileList: fileIDs }).catch((err) => {
            console.error('deleteFile error:', err);
          });
        }
        return { code: 0, message: '删除成功' };
      }

      default:
        return {
          code: 1,
          message: '不支持的操作：' + action + '（云端版本 v' + CODE_VERSION + '）'
        };
    }
  } catch (err) {
    console.error('manageGoods error:', action, err);
    return { code: -1, message: '操作失败：' + err.message };
  }
};
