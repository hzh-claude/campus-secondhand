// cloudfunctions/publishGoods/index.js
// 发布商品：参数校验 → 内容安全检测 → 写入 goods 集合
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const GOODS = 'goods';
const USERS = 'users';
const MAX_TEXT_LEN = 2500; // msgSecCheck 单次上限

// 商品描述的字数上限。
//
// ⚠️ 必须和 pages/push/push.wxml 里那个 textarea 的 maxlength="200" 一致。
//    前端那个只是【体验层】：它让用户当场就知道写超了，而不是提交完
//    转一圈回来才被拒。**真正算数的是这里** —— 绕过小程序直接调云函数
//    就能跳过前端的 maxlength。
//
// 【2026-10-16 补上这个判断，起因是一个很隐蔽的空子】
//   在此之前 description 【没有任何上限】，而 checkContent 里有一句
//   slice(0, MAX_TEXT_LEN)。两件事单独看都对，凑在一起就出事：
//   送检的是前 2500 字，落库的是完整串 ——
//   「前 2500 字正常 + 后面接违规内容」可以过检。
//   ⚠️ 送检的串和落库的串【必须是同一个】，这是内容安全检测的前提。
//   加上这个 200 的上限之后，标题 30 + 描述 200 + 成色 20 一共 250 < 2500，
//   slice 永远不会真的截断，两边就一致了。
//
//   同一条规则也在 cloudfunctions/manageGoods/index.js（编辑商品那条路）。
//   只改新建不改编辑，等于「发布时拦得住、编辑时能绕过去」。
const DESC_MAX = 200;

// 成色 / 补充说明字段的字数上限。
//
// 这个字段现在【没有任何页面在传】了（推一下：全项目只有 detail.js 读它，
// 没有任何页面写它），但服务端还在收、还在落库 —— 于是它变成一条
// 「只有直接调云函数才能碰到」的无上限写入。加个上限堵掉，
// 同时把它一起送检（见下面 checkContent 那一行）。
// 没有直接删掉这个字段，是为了不动老数据里已有的值。
const CONDITION_MAX = 20;

// 部署版本号：每次改动都 +1，随返回值一起发给前端。
//
// 【为什么这个函数特别需要它】
//   2026-10 排查「没注册也能发布商品」时发现：这个函数里明明有
//   requireVerified（V-04 加的），真机上却照样能发。原因是云端跑的
//   还是旧版本 —— 而它当时【连一个版本号都没有】，翻返回值、翻界面
//   都看不出云端到底是哪一版，只能靠猜。
//
//   现在成功返回里也带上 v（不只是失败路径）。这是故意的：
//   「部署没生效」的表现恰恰是【旧的、没有闸门的版本成功了】，
//   拿不到版本号。所以成功返回体才是最需要这个探针的地方。
//   前端 push.js 把它打进 Console，见 onSubmit。
//
//   ⚠️ 别因为「成功返回体里多个字段不好看」把它删掉。它是排查手段，
//      不是业务数据。
const CODE_VERSION = 4;


// ============================================================
// 【V-01 / V-04 / V-07 修复】新加的三个服务端校验工具
// ============================================================

// 商品图片的云存储目录前缀。
//
// ⚠️ 必须和 utils/cloud-config.js 的 CLOUD_PATH.GOODS_IMAGE、
//    cloudfunctions/manageGoods/index.js 里的同名常量一致！
//    云函数 require 不到 utils，只能各写一份。搜索 GOODS_IMAGE 能找到三处。
//
// 【为什么服务端也要拥有一份】
//    客户端上传时拼的 cloudPath 是客户端自己拼的，可以指向任意目录。
//    「按目录区分用途」只有服务端也认这份约定，才真的成立 ——
//    否则任何文件都能被塞进商品图字段，再被删除动作当成商品图处理。
const GOODS_IMAGE_PREFIX = 'goods/';

// 当前云环境 ID（缓存一次，避免每次都走 getWXContext）。
// 取不到时返回空串，校验自动降级为「只判目录前缀」。
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

// 商品图片 fileID 白名单：本环境 goods/<调用者 openid>/ 目录下的云文件。
// 判据与 manageGoods 里的同名校验保持一致（两处必须同改）。
//
// 只判 goods/ 不够：那张图将来会被 remove 拿去删，入口不锁到主人，
// 任何人把自己商品的 images 写成别人的 fileID 再删，就能删掉别人的图。
function isOwnGoodsImage(fileID, openid) {
  if (typeof fileID !== 'string' || !openid) return false;
  const id = fileID.trim();
  if (!id) return false;

  const m = /^cloud:\/\/([^/]+)\/(.+)$/.exec(id);
  if (!m) return false;

  // 【跨环境判断 —— 这里写错过一次，别再改回 `m[1] !== envId`】
  //
  //   m[1] 是 fileID 里第一个 / 之前的那一段，形状是「<环境ID>.<存储桶>」。
  //   这一点本项目自己的注释里写着（见 chat/index.js 的 validChatImageFile：
  //   「fileID 形如 cloud://<环境>.<存储桶>/<路径>」）。
  //   而 currentEnvId() 从 getWXContext 拿到的 ENV 是【纯环境 ID】。
  //
  //   所以原来那句 `m[1] !== envId` 是拿
  //       cloud1-xxxx.636c-cloud1-xxxx-1300xxxxxx
  //   去比
  //       cloud1-xxxx
  //   永远不相等 —— 于是【每一张图都在这里被当成"别的环境的文件"剔掉】。
  //   现象：前端图明明传上去了、预览也在，点发布却收到「请上传商品图片」，
  //   而且前端一点错都不报（服务端只打了一行 warn）。
  //
  //   下面这种写法两种形状都认（正好等于环境 ID，或以「环境ID.」开头），
  //   所以不管 fileID 带不带存储桶段都不会误杀。
  const envId = currentEnvId();
  if (envId && m[1] !== envId && m[1].indexOf(envId + '.') !== 0) return false;

  const path = m[2];
  if (path.indexOf('..') !== -1) return false;

  const prefix = GOODS_IMAGE_PREFIX + openid + '/';
  return path.indexOf(prefix) === 0 || path.indexOf('/' + prefix) >= 0;
}

// 身份准入：发布商品的人必须已完成核验（users.verified === true）。
//
// 【为什么"发布"必须卡】
//    发布是把内容投放给他人的入口，也是本项目内容安全检测的
//    主要对象。以前未注册（users 里根本没档案）的人可以直接发布，
//    服务端还会给他兜底一个「校园用户」的昵称 —— 等于核验门槛
//    在服务端完全不存在。这里补上它。
//
// 【判据和 user / order / chat 三处保持一致】
//    存在档案 且 verified === true。四处都要同改。
async function requireVerified(openid) {
  const res = await db
    .collection(USERS)
    .where({ _openid: openid })
    .limit(1)
    .get()
    .catch(() => null);
  const user = (res && res.data && res.data[0]) || null;
  if (!user || user.verified !== true) {
    return { ok: false, code: 403, message: '请先完成校内身份核验后再发布商品' };
  }
  return { ok: true, user };
}

// 售价上限与小数位。
//
// ⚠️ 必须和 utils/cloud-config.js、cloudfunctions/manageGoods/index.js 里的同名常量一致！
//    云函数是独立部署的，require 不到 utils，只能各写一份。
//    搜索 PRICE_MAX 能同时找到这三个地方。
//
// 这里才是真正的门禁：前端的输入清洗和提交校验都只是【体验】，
// 绕过小程序直接调云函数就能全部跳过。上限这条规则必须在这儿再落一遍。
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
// ⚠️ 必须和 utils/categories.js、cloudfunctions/manageGoods/index.js
//    里的同名常量一致！搜索 QUANTITY_MAX 能同时找到这三个地方。
//
// 和价格一样，前端的输入清洗只是【体验】—— 绕过小程序直接调云函数
// 就能跳过。这道才是真正拦住它的地方。
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
//   商品的 campus 存的是整串：「松园·松一」。真正合法的值有 20 个
//   （4 个园区 + 松园5/桃园7/荷园7 个楼栋）。把那 20 个字符串在这里
//   再抄一遍，等于给「以后加一栋楼要改三个文件」埋雷。
//   而 campus 最终只是【显示给买家看的一行字】，不参与任何判断，
//   所以卡住「必须以某个园区名开头」就够了 —— 拦得住乱填的，
//   又不用维护那张表。真正的表单约束在前端的选择器里。
const CAMPUS_ROOTS = ['荷园', '松园', '桃园', '竹园'];

function isTradeCampus(campus) {
  return CAMPUS_ROOTS.some((root) => campus.indexOf(root) === 0);
}

// 取卖家档案，快照进商品记录
//
// ① 为什么不直接用 event.publisher？——前端传的身份信息可以伪造，
//    调用者能把昵称改成「官方客服」去发布商品，必须由服务端按 OPENID 自己查。
// ② 为什么用「快照」而不是查询时关联？——商品列表页是直连数据库读的，
//    如果卖家昵称头像要现查 users 表，每查一页商品就得再关联一次；
//    快照存进商品记录里，一次查询就全拿到了。
//    代价是用户改资料后旧商品不会自动变，由 user 云函数的 updateProfile 负责同步。
//
// ⚠️【白名单：这个对象的每一个字段都会对所有微信用户公开】
//    goods 集合是【公开可读】的（首页/分类/搜索/详情都是客户端直连），
//    所以这里返回什么，就等于对所有人公示什么。
//    users 档案里的 realName（真实姓名）【绝不能】加进来 ——
//    真实姓名只有管理员和用户本人可见，而且一旦写进商品快照，
//    已发布的那批商品会一直挂着，事后删都删不干净。
//    加字段之前先问一句：这个值是要给陌生人看的吗？
//
//    同样的约束还在另外两处（它们也都在给「别人」造快照）：
//      cloudfunctions/order/index.js  getUserBrief
//      cloudfunctions/chat/index.js   profileOf
//    搜索 realName 能同时找到这几个地方。
async function buildPublisher(openid, campus) {
  const res = await db
    .collection(USERS)
    .where({ _openid: openid })
    .limit(1)
    .get()
    .catch(() => null);

  const user = (res && res.data && res.data[0]) || {};
  return {
    avatar: user.avatar || '',
    nickname: user.nickname || '校园用户',
    // 取商品本身的交易地点，而不是用户的常驻宿舍 ——
    // campus 字段名在两处含义不同：商品上表示「在哪儿面交/取货」，
    // 用户档案和收货地址上表示「我住在哪儿」。前端标签已经用
    // 「交易地点」把它们分开了，别再把这两个概念混回一句话里。
    campus
  };
}

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

exports.main = async (event) => {
  // 云函数中 add 不会自动写入 _openid，必须手动取调用者身份
  const { OPENID } = cloud.getWXContext();

  // 【V-04 修复】发布前先过身份准入。
  //
  // 【为什么放在最前面】
  //   这个位置之后是「参数校验 → 内容安全检测 → 写库」，
  //   后两步都要花钱（msgSecCheck 是一次远端调用）。
  //   未核验的账号在这里就被挡住，不给它消耗内容安全配额的机会 ——
  //   否则刷一晚上就能把当天的免费额度耗光，正常用户反而发不出商品。
  //
  // 【为什么发布必须卡这道门】
  //   发布是把内容投放给他人的入口。以前 users 里根本没有档案的人
  //   也能直接发布，服务端还给他兜底一个「校园用户」的昵称 ——
  //   「学号 + 校内定位」这道核验门槛在服务端形同不存在。
  const gate = await requireVerified(OPENID);
  if (!gate.ok) {
    // 带上 v：这一条正是「核验闸门到底有没有生效」的探针。
    // 看不到 v，说明云端跑的是没有这道门的旧版本，去重新部署。
    return { code: gate.code, message: gate.message, v: CODE_VERSION };
  }

  const title = String(event.title || '').trim();
  const description = String(event.description || '').trim();
  const price = Number(event.price);
  // 没传就是 1（老前端），传了就必须合法 —— 见 normalizeQuantity 的说明
  const quantity = normalizeQuantity(event.quantity);
  const category = String(event.category || '').trim();
  const campus = String(event.campus || '').trim();
  // contact 已下线：它曾经被收上来、写进库、还一起做内容安全检测，
  // 但详情页从来没展示过 —— 卖家填了等于白填。
  // 更要命的是它被 join 进 checkContent，撞上敏感词会导致【整个发布失败】，
  // 而报错指向标题和描述，用户根本查不出原因。
  // 老数据里的 contact 字段保留不动（不再读、不再写）。
  const condition = String(event.condition || '').trim();
  // 【V-01 / V-07 修复】images 不是「取前 9 个」就算完，还要逐个过目录白名单。
  // 入口只放行本环境 goods/<调用者 openid>/ 下的文件。
  const rawImages = Array.isArray(event.images) ? event.images.slice(0, 9) : [];
  const images = rawImages.filter((id) => isOwnGoodsImage(id, OPENID));
  const invalidImageCount = rawImages.length - images.length;
  if (invalidImageCount > 0) {
    console.warn(
      '[publishGoods] 剔除了 ' + invalidImageCount +
      ' 个非本人 goods/<openid>/ 目录的图片，openid=' + OPENID
    );
  }

  // 服务端二次校验（客户端校验不可信）
  if (!title) return { code: 1, message: '请输入商品标题' };
  if (title.length > 30) return { code: 1, message: '商品标题不能超过30个字' };
  // 描述必填。前端那颗红星和 onSubmit 里的校验都只是【体验】，
  // 绕过小程序直接调云函数就能跳过 —— 所以规则必须在这儿再落一遍。
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
  // 两种「没图」要分开报：
  //   · rawImages 本来就是空的 → 用户确实没传；
  //   · rawImages 有、却被上面的白名单剔光了 → 图传上来了，但服务端不认。
  // 合成同一句话的代价是排查时间：用户看着图就在页面上，
  // 系统却说「请上传商品图片」，他只会反复重传、永远查不到原因。
  // （上面那句 console.warn 里也带着剔除数量，两边对得上。）
  //
  // 【文案里为什么要带「云端 vN」】
  //   「图片明明传上去了，却说我没上传」只有两种可能：
  //     (1) 前端真的没把 fileID 送上来 —— 此时 rawImages 为空；
  //     (2) 云端跑的是旧代码（v1 那版把每张图都当外环境文件剔了）——
  //         此时 rawImages 非空、invalidImageCount 为正。
  //   这两种【在手机上看长得一模一样】：都是同一个弹窗。
  //   用户没法开控制台，但会截图 —— 把版本号写进文案，截图本身就
  //   能分辨：看到 v1 或看不到 v，就是「部署没生效」，不用再猜。
  //   这和文件末尾异常分支里那句「（云端版本 v…）」是同一个办法。
  //
  //   ⚠️ 收到图片数也要打日志。旧的 warn 只在「剔了图」时才打，
  //      「一张都没收到」时日志上什么都没有 —— 恰恰是最需要区分的那种。
  console.log(
    '[publishGoods] v' + CODE_VERSION +
    ' 收到图片 ' + rawImages.length +
    ' 张，通过白名单 ' + images.length + ' 张'
  );
  if (images.length === 0) {
    return {
      code: 1,
      message: invalidImageCount > 0
        ? '商品图片校验未通过，请删除后重新上传（云端 v' + CODE_VERSION + '）'
        : '请上传商品图片（云端 v' + CODE_VERSION + '）'
    };
  }

  // 内容安全检测
  //
  // ⚠️ condition 也一起送检。它虽然没有任何页面在展示、也没有任何页面在传，
  //    但它是【会落库的文本】，就按会落库的文本对待 ——
  //    「哪个字段要送检」的正确判据是「它会不会被写进去」，
  //    不是「它现在有没有人看」。
  const check = await checkContent([title, description, condition].join('\n'));
  if (!check.pass) {
    return { code: check.code, message: check.message };
  }

  const now = new Date();

  try {
    // 卖家信息由服务端按 OPENID 自己查，不接受前端传入
    const publisher = await buildPublisher(OPENID, campus);

    const res = await db.collection(GOODS).add({
      data: {
        // 商品归属人：manageGoods 的 listMine / 归属校验都依赖此字段
        _openid: OPENID,
        title,
        description,
        price,
        // 出售数量。它不参与下单、不做库存扣减 —— 商品卖出是整体变 sold，
        // 不会从 3 减到 2。详细说明见 utils/categories.js 顶部那段。
        quantity,
        category,
        campus,
        condition,
        images,
        views: 0,
        // 这里曾经有个 favorites: 0，是给详情页「N人收藏」用的。
        // 但它从发布那一刻就定死成 0、再没有任何代码去改它 —— 是个永远不动的假数字。
        // 现在收藏数由 favorite 云函数实时 count，这个字段已废弃，不再写入。
        // 老数据里残留的 favorites 字段无害：没有任何代码再读它了。
        status: 'on_sale',
        publisher,
        createTime: now,
        updateTime: now
      }
    });

    // v 不是业务字段，是部署探针 —— 见文件顶部 CODE_VERSION 的说明。
    // 【成功也带】是关键：部署没生效的表现是旧版本成功，拿不到版本号。
    return { code: 0, message: '发布成功', _id: res._id, v: CODE_VERSION };
  } catch (err) {
    console.error('publishGoods error:', err);
    return { code: -1, message: '发布失败：' + err.message + '（云端版本 v' + CODE_VERSION + '）' };
  }
};
