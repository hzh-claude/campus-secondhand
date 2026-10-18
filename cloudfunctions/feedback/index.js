// cloudfunctions/feedback/index.js
// 意见反馈：提交（文字 + 截图 + 联系方式）/ 我的反馈列表
//
// ============================================================
// 【管理员操作手册 —— 这个项目没有小程序内的管理页，就靠这段】
// ============================================================
//
// 用户提交的反馈在哪看、怎么处理：
//
//   1. 云开发控制台 → 数据库 → feedback 集合
//   2. 筛 status = pending，这些是还没处理的
//   3. 处理完了，把这条文档的 status 字段改成【精确的字符串】 done
//      ⚠️ 是小写、不带引号、前后不要有空格。
//         打成 Done / DONE / 已处理 / resolved 都不算 ——
//         用户那边会【继续显示「处理中」】。
//         这是故意的，理由见下面 FEEDBACK_STATUS 的说明。
//   4. 想给用户一句回话，就填 reply 字段（字符串）。
//      填了之后用户在「我的反馈」里能看到；不填就不显示那一块。
//   5. 没有「处理时间」字段可填。列表只显示提交时间。
//      原因见下面 add 那段：控制台手改文档不会触发任何时间戳更新。
//
// 这个集合的权限必须是【仅管理端可读写】：
//   给客户端任何写权限的话，用户就能把自己的 status 改成 done、
//   或者自己填一条看起来像官方回复的 reply。
//
// ============================================================
// 统一返回格式：{ code: 0, message: 'ok', ... }，code !== 0 表示失败
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

// ⚠️ 必须和 utils/cloud-config.js 的 COLLECTION.FEEDBACK 一致！
//    云函数 require 不到 utils，只能两处各写一份。
//    搜索 FEEDBACK 能同时找到这两个地方。
const FEEDBACK = 'feedback';

// ⚠️ 必须和 utils/cloud-config.js 的 CLOUD_PATH.FEEDBACK_IMAGE 一致！
//    那边是客户端上传时用的目录，这边是服务端校验用的。
//    改一个不改另一个，症状是「图片永远提交不上去」，报错却是
//    「只能提交本次上传的截图」—— 听起来像用户的问题，其实是这两处没对上。
//    搜索 FEEDBACK_IMAGE 能同时找到这两个地方。
//
// 【注意这个前缀后面还要再拼一层 openid】完整路径是：
//     feedback/<上传者的 openid>/<时间戳-随机数>.<后缀>
// 多出的那一层是安全边界，不是整理用的，理由见 validFeedbackImage。
const FEEDBACK_IMAGE = 'feedback/';

// ⚠️ 必须和 utils/cloud-config.js 的 FEEDBACK_TYPE 一致！
//    搜索 FEEDBACK_TYPE 能同时找到这两个地方。
//    值是【存进库的】，不要改；要加类型往后加，别动已有的值。
const FEEDBACK_TYPE = ['feature', 'bug', 'trade', 'other'];

// ⚠️ 必须和 utils/cloud-config.js 的 FEEDBACK_STATUS 一致！
//    搜索 FEEDBACK_STATUS 能同时找到这两个地方。
//
// 【这里只用来写默认值，不用来做判断】
//   判断「是否已处理」只在 frontend 一处做，而且只认精确的 'done'。
//   管理员在控制台手改 status 时打错字（'Done' / '已处理' / 'resolved'），
//   用户那边会继续看到「处理中」。
//   这是【故意】的保守方向：打错字最坏的结果是「处理了但显示处理中」，
//   用户多等；反过来写成「不是 pending 就算已处理」的话，打错一个字
//   就会让没处理的显示成已处理 —— 用户以为有人管了，于是不再追问，
//   这条反馈就真死了。宁保守，不撒谎。
const STATUS_PENDING = 'pending';

const FEEDBACK_IMAGE_MAX = 3; // ⚠️ 搜索 FEEDBACK_IMAGE_MAX
const FEEDBACK_CONTENT_MAX = 500; // ⚠️ 搜索 FEEDBACK_CONTENT_MAX
const FEEDBACK_DAILY_MAX = 10; // ⚠️ 搜索 FEEDBACK_DAILY_MAX

const CONTACT_MAX = 100; // 联系方式上限。它不送检，所以只能靠长度兜一道

const MAX_TEXT_LEN = 2500; // msgSecCheck 单次上限

// imgSecCheck 的硬限制：图片要小于 1M。
// 超了接口直接报错，而报错会走到「服务异常」分支 —— 用户看到的是
// 「稍后重试」，重试多少次都一样。所以这里先自己拦下来，给一句能照着做的提示。
// 客户端上传前有一次压缩 + 体积检查（suggest.js），正常情况下走不到这儿。
const IMG_CHECK_MAX = 1024 * 1024;

// 允许的图片后缀。imgSecCheck 只认这几种，白名单之外的（尤其是视频、
// 音频文件）在这里就挡掉 —— 不然会拿一个 mp4 去调图片检测接口，
// 报一个看不懂的错。
const IMG_EXT_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp'
};

const LIST_LIMIT = 30; // 单次拉取条数
const DAY_MS = 24 * 60 * 60 * 1000;

// 部署版本号：每次改动 +1。
// 「不支持的操作：xxx」这个报错九成是云函数没部署成功、云端还跑着旧代码。
// 版本号必须出现在【失败】路径上 —— 装在成功返回里等于失明，
// 因为部署没生效时你恰恰在失败那一边，根本看不到它。
const CODE_VERSION = 1;

// 校验反馈截图的 fileID，通过返回 { ok: true, contentType }，否则 { ok: false, message }
//
// 【为什么要白名单，不能只看「是个 fileID 就行」】
//   不校验的话，用户可以往 images 里塞任意 fileID —— 包括别人的头像、
//   商品图、聊天图、甚至别的云环境的文件。反馈是存库的，
//   等于把它当成了一个「任意云文件引用」的容器。
//
// 【为什么光判 feedback/ 不够，还要精确到「自己 openid 那一层」】
//   因为下面在检测不通过时会【删掉】这个文件。只判 feedback/ 的话，
//   任何登录用户只要拿到（或者猜到）别人反馈截图的 fileID，就能构造一次
//   请求让服务端把别人的图删了。文件删除是不可逆的，这个口子不能留。
//
//   客户端上传时的路径正是 feedback/<openid>/<文件名>（见 suggest.js 的
//   uploadOne）。把 openid 并进白名单后，服务端能【独立验证】这张图
//   是不是调用者自己的 —— 用的 openid 来自 getWXContext，客户端伪造不了。
//
// 【为什么不能用「每次提交生成的随机 token 目录」代替 openid】
//   token 会随路径写进 fileID 本身。攻击者只要拿到受害者的 fileID，
//   就等于同时拿到了那个 token，服务端 startsWith('feedback/<token>/')
//   照样通过 —— 那不是真边界，只是看起来像。
//   只有「拿调用者自己的 openid 去比」才是服务端说了算的边界。
//
// 【openid 出现在存储路径里，会不会泄露身份】
//   这份 fileID 只会回到上传者自己手里（listMine 按 _openid 过滤，
//   别人的反馈你连 fileID 都看不到）。而且 openid 是 app 级的
//   不透明标识、不是凭据 —— 拿到它也做不了任何事。
//   文件名仍然用「时间戳 + 随机数」，不把 openid 写进文件名。
function validFeedbackImage(fileID, openid) {
  const id = String(fileID || '').trim();

  // 只认云存储 fileID。https 外链一律不收：
  // 那会让反馈里出现任意站外图片，既没法审核也没法清理。
  if (id.indexOf('cloud://') !== 0) {
    return { ok: false, message: '只支持上传到云存储的截图' };
  }

  // fileID 形如 cloud://<环境>.<存储桶>/<路径>，取第一个 / 之后的部分当路径。
  const afterScheme = id.slice('cloud://'.length);
  const slash = afterScheme.indexOf('/');
  if (slash < 0) return { ok: false, message: '图片地址不合法' };

  const path = afterScheme.slice(slash + 1);

  // 【为什么是两个条件，而不是只判 startsWith】
  //   云存储 fileID 的路径段在不同环境/不同上传方式下，有的就是
  //   feedback/xxx.png，有的前面还会再带一段环境标识。只判 startsWith
  //   会在后者上把【所有】正常图片都拒掉，而且报的是「只能提交反馈截图」，
  //   查半天查不出所以然。两种形状都放行，同时仍然挡掉
  //   goods/xxx.png、avatar/xxx.png、chat/xxx.png 这些别的目录。
  //
  // ⚠️【别把这里改「严」】——这个判断确实会放行一种看起来可疑的路径：
  //       goods/feedback/<openid>/a.png
  //   （因为 '/' + FEEDBACK_IMAGE 在 goods 后面匹配上了）。
  //   实测确认过，这不是漏洞，改成严格 startsWith 反而会把所有图片搞挂：
  //     · 能造成伤害的动作只有一个 —— 删除。而删除还要同时过下面那道
  //       「feedback/<调用者自己的 openid>/」检查。所以攻击者顶多能删掉
  //       「路径里写着他自己 openid」的文件 —— 那种文件他本来就能自己传、
  //       自己删，删它不构成越权。
  //     · 别人的商品图是 goods/<时间戳>.png，路径里根本没有 feedback 段，
  //       上面两个条件都不满足，删不到。
  //   换句话说：真正兜住安全的是【openid 那一段】，不是 feedback/ 这一段。
  //   这里松一点是为了兼容 fileID 的两种形状，换成严格前缀会牺牲兼容性
  //   却换不来任何安全性。
  const inFeedbackDir =
    path.indexOf(FEEDBACK_IMAGE) === 0 || path.indexOf('/' + FEEDBACK_IMAGE) >= 0;
  if (!inFeedbackDir) {
    return { ok: false, message: '只能提交反馈截图' };
  }

  // 自己 openid 那一层必须对得上。这一段不能省，理由见上面第二段。
  // ⚠️ openid 来自调用方传入的形参，而调用方传的是 getWXContext 的值，
  //    【绝不是】event 里客户端自己填的东西。
  if (path.indexOf(FEEDBACK_IMAGE + openid + '/') < 0) {
    return { ok: false, message: '只能提交本次上传的截图' };
  }

  const ext = (path.split('.').pop() || '').toLowerCase();
  const contentType = IMG_EXT_MIME[ext];
  if (!contentType) {
    return { ok: false, message: '图片格式不支持，请换一张' };
  }

  return { ok: true, contentType };
}

// 判断这个 fileID 是不是「调用者自己目录下」的文件。
// deleteOwnImages 用它做最后一道闸，所以单独抽出来。
function inOwnFeedbackDir(fileID, openid) {
  return validFeedbackImage(fileID, openid).ok;
}

// 把本次上传的截图从云存储里删掉。
//
// 【什么时候调它】
//   客户端是「先上传、再 callFunction」的两步结构（云函数没法替客户端上传），
//   所以只要 submit 走到了这里，图【已经】躺在云存储里了。
//   于是任何一条失败路径 —— 目录校验不过、频率超限、文本不过、某张图不过、
//   写库抛异常 —— 在 return 之前都必须调一次，否则就是一堆永远不会被
//   引用的孤儿文件。而且这类孤儿没有任何地方会发现它们。
//
// 【为什么永不 throw】
//   它总是出现在某个失败分支里。要是它自己再抛一次，真正的原因
//   （文本违规 / 图片违规）就会被这第二个错误盖掉，用户看到一句莫名其妙的
//   「操作失败」。删不掉只是运维该看日志的事，不该让用户多等一个错。
//
// 【为什么内部要再判一次目录】
//   调用方传进来的可能是「一锅端」的完整列表（里面混着不合法的 fileID）。
//   删除不可逆 —— 这里再判一次，等于「不管调用方怎么传，都别想删到
//   别人的文件」。这是防构造请求的最后一道门。
async function deleteOwnImages(fileIDs, openid) {
  const list = (fileIDs || []).filter((id) => inOwnFeedbackDir(id, openid));
  if (!list.length) return;

  for (const fileID of list) {
    try {
      await cloud.deleteFile({ fileList: [fileID] });
    } catch (err) {
      console.warn('[反馈] 清理截图失败，fileID=', fileID, err);
    }
  }
}

// 内容安全检测：pass 放行，review / risky 拒绝；接口异常一律拒绝（绝不放行）
//
// 和 cloudfunctions/publishGoods、cloudfunctions/chat 里的同名函数是同一套。
// 【fail-closed 是这个函数唯一不能改的性质】：宁可让用户重发一次，
// 也不能因为接口挂了就把没检测过的内容放进去。
async function checkContent(content, openid) {
  const text = String(content || '').slice(0, MAX_TEXT_LEN);
  if (!text.trim()) return { pass: true };

  try {
    const res = await cloud.openapi.security.msgSecCheck({
      version: 2,
      scene: 2,
      // ⚠️ 必须是【调用者】的 openid。风控要靠它定位到人，
      //    传前端填的值等于让违规内容匿名。
      openid,
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

// 图片内容安全检测。
//
// 【和 checkContent 一样，一律 fail-closed】
//   接口异常、下载失败、体积不达标 —— 全部按「不让过」处理。
//   宁可让用户重发一次，也不能让一张没检测过的图存进库。
async function checkImage(fileID, openid) {
  const valid = validFeedbackImage(fileID, openid);
  if (!valid.ok) return { pass: false, code: 1, message: valid.message };

  let buffer;
  try {
    const res = await cloud.downloadFile({ fileID });
    buffer = res && res.fileContent;
  } catch (err) {
    console.error('下载反馈截图失败:', err);
    return { pass: false, code: -2, message: '图片读取失败，请重发一次' };
  }

  if (!buffer || !buffer.length) {
    return { pass: false, code: 1, message: '图片是空的，请重发一次' };
  }

  if (buffer.length > IMG_CHECK_MAX) {
    return { pass: false, code: 1, message: '图片太大了（超过 1M），请换一张' };
  }

  try {
    await cloud.openapi.security.imgSecCheck({
      media: {
        contentType: valid.contentType,
        value: buffer
      }
    });
    // 同步版的 imgSecCheck【没有 suggest 字段】：通过就是正常返回，
    // 不通过是抛 errCode 87014。所以这里没有 if 要判，
    // 能走到这一行就是通过了。
    // （别照抄 checkContent 的 suggest 三态判断，那套在这里用不上。）
    return { pass: true };
  } catch (err) {
    if (err && err.errCode === 87014) {
      return { pass: false, code: 87014, message: '图片涉嫌违规，请换一张' };
    }
    console.error('imgSecCheck error:', err);
    return { pass: false, code: -2, message: '图片安全检测服务异常，请稍后重试' };
  }
}

// 这台机器上「现在」往前的 24 小时窗口。
// 抽出来是为了让下面 count 那句读起来像人话。
function oneDayAgo() {
  return new Date(Date.now() - DAY_MS);
}

// 提交反馈
//
// ============================================================
// 【执行顺序本身是有理由的，不是随便排的】
//
//   字段校验（纯本地）
//     → fileID 目录/后缀校验（纯本地，无 IO）
//     → 频率限制（1 次 count）
//     → msgSecCheck（1 次 API，【文本先检】）
//     → 逐张 下载 + imgSecCheck（最贵）
//     → 写库
//
// 【文本为什么排在图片前面】
//   图片检测每张都要「下载 + 调接口」，是这一整串里最贵的一步。
//   文本不过是最常见的失败原因，先检它，能省掉最多 3 次下载 + 3 次接口调用。
//   注意：这不是「先检谁就少删几个文件」—— 见下面那段。
//
// 【为什么每条失败路径都要清图】
//   客户端是「先上传、再 callFunction」的两步结构（云函数没法替客户端上传）。
//   所以调到这里时，图【已经】在云存储里了，跟先检谁无关。
//   清理不是「省着删」，而是「任何失败都要删干净」。
//   所以下面每一条 return 前面都跟着一次 deleteOwnImages。
// ============================================================
async function submit(openid, event) {
  // ---- 1. 字段校验 ----
  const type = String(event.type || '').trim();
  const content = String(event.content || '').trim();
  const contact = String(event.contact || '').trim();

  if (FEEDBACK_TYPE.indexOf(type) < 0) {
    return { code: 1, message: '请选择反馈类型' };
  }
  if (!content) {
    return { code: 1, message: '请填写问题描述' };
  }
  if (content.length > FEEDBACK_CONTENT_MAX) {
    return { code: 1, message: '描述不能超过 ' + FEEDBACK_CONTENT_MAX + ' 个字' };
  }
  // ⚠️ contact 【故意不送 msgSecCheck】。
  //    publishGoods 栽过一次：把联系方式 join 进去检测，结果用户描述里
  //    一个字都没问题，却因为手机号被判定成敏感内容而整条提交失败，
  //    报错还指向「描述」。联系方式是选填、只有管理员看得到、不公开，
  //    风险可控，限长兜一道就够了。
  if (contact.length > CONTACT_MAX) {
    return { code: 1, message: '联系方式太长了' };
  }

  // ---- 2. 截图：数量 + 目录/后缀校验（纯本地，没有 IO）----
  const images = Array.isArray(event.images)
    ? event.images
        .filter((x) => typeof x === 'string' && x.trim())
        .map((x) => x.trim())
    : [];

  if (images.length > FEEDBACK_IMAGE_MAX) {
    // 传多了也要清 —— 里面可能有本来已经传上去的图
    await deleteOwnImages(images, openid);
    return { code: 1, message: '最多只能上传 ' + FEEDBACK_IMAGE_MAX + ' 张截图' };
  }

  for (const fileID of images) {
    const valid = validFeedbackImage(fileID, openid);
    if (!valid.ok) {
      // 把整串都交给 deleteOwnImages：它内部只删「自己目录下」的那些，
      // 不合法的会被跳过 —— 所以那个不属于我们的 fileID 不会被碰。
      await deleteOwnImages(images, openid);
      return { code: 1, message: valid.message };
    }
  }

  // ---- 3. 频率限制 ----
  // 用 count() 而不是把列表拉回来数长度：列表有 LIST_LIMIT 上限，
  // 超过之后数出来的数就不对了。
  const recent = await db
    .collection(FEEDBACK)
    .where({ _openid: openid, createTime: _.gte(oneDayAgo()) })
    .count();

  if ((recent.total || 0) >= FEEDBACK_DAILY_MAX) {
    await deleteOwnImages(images, openid);
    return {
      code: 1,
      message: '今天提交的反馈有点多，请明天再试'
    };
  }

  // ---- 4. 文本内容安全（先检，理由见函数头）----
  const textCheck = await checkContent(content, openid);
  if (!textCheck.pass) {
    await deleteOwnImages(images, openid);
    return { code: textCheck.code, message: textCheck.message };
  }

  // ---- 5. 逐张图片检测（最贵，放最后）----
  for (const fileID of images) {
    const imgCheck = await checkImage(fileID, openid);
    if (!imgCheck.pass) {
      await deleteOwnImages(images, openid);
      return { code: imgCheck.code, message: imgCheck.message };
    }
  }

  // ---- 6. 写库 ----
  const now = new Date();

  try {
    const res = await db.collection(FEEDBACK).add({
      data: {
        // ⚠️ 必须手动写。云函数里 add 【不会】自动写 _openid，
        //    漏了的话这条记录的归属就是空的，listMine 按 _openid 查
        //    永远查不到它 —— 而且不报错，用户会以为自己的反馈丢了。
        _openid: openid,
        type,
        content,
        contact,
        images,
        status: STATUS_PENDING,
        // 管理员在控制台填。默认空串而不是 undefined：
        // 空串在前端是「没有回复」这个明确的意思，undefined 会让
        // 列表页要多判一次 typeof。
        reply: '',
        createTime: now,
        // ⚠️ 这个字段【不代表处理时间】。
        //    管理员在控制台手改文档不会触发任何自动更新，
        //    所以它永远等于 createTime。留着是为了和其他集合的文档形状一致。
        //    列表页只显示 createTime，不要显示 updateTime。
        updateTime: now
      }
    });

    return { code: 0, message: '提交成功', id: res._id };
  } catch (err) {
    console.error('feedback add error:', err);
    // 写不进去，那这几张图也没有引用了，一起清掉
    await deleteOwnImages(images, openid);
    return { code: -1, message: '提交失败，请稍后重试' };
  }
}

// 我的反馈列表
//
// 按 createTime 倒序 —— 反馈永远只看最新的，不做增量拉取。
async function listMine(openid) {
  const res = await db
    .collection(FEEDBACK)
    // ⚠️ 这个 where 不能省，也不能改成从 event 里取 openid。
    //    它就是「只能看到自己的反馈」这条规则本身。
    //    openid 来自 getWXContext，是微信认证过的，客户端传什么都伪造不了。
    .where({ _openid: openid })
    .orderBy('createTime', 'desc')
    .limit(LIST_LIMIT)
    .get();

  const list = (res.data || []).map((f) => ({
    id: f._id,
    type: f.type || 'other',
    content: f.content || '',
    contact: f.contact || '',
    images: Array.isArray(f.images) ? f.images : [],
    // 原样透传，不做「是不是 done」的判断 —— 那条规则只有前端一处，
    // 在这边再判一次就是同一条规则存两份，改的时候必然漏一处。
    status: f.status || '',
    reply: f.reply || '',
    createTime: f.createTime
  }));

  return { code: 0, message: 'ok', list };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const action = (event && event.action) || '';

  try {
    switch (action) {
      case 'submit':
        return await submit(OPENID, event);
      case 'listMine':
        return await listMine(OPENID);
      default:
        return {
          code: -1,
          message: '不支持的操作：' + action + '（云端版本 v' + CODE_VERSION + '）'
        };
    }
  } catch (err) {
    console.error('feedback error:', action, err);
    return { code: -1, message: '操作失败：' + err.message };
  }
};
