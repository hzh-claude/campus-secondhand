// cloudfunctions/chat/index.js
// 聊天：会话管理 + 消息收发
//
// ============================================================
// 为什么走云函数，而不是像 goods 那样客户端直连 + watch 实时监听
// ============================================================
//
// 云开发的 db.collection().watch() 本来最合适，但它被读权限卡死：
//   实时推送【同样受集合读权限限制】——权限是「仅创建者可读」时，
//   就监听不到别人创建的数据。而聊天消息天然是双方都要读的，
//   要实时就得把集合设成「所有人可读」，那等于全站聊天记录公开。
//   想用安全规则写「我参与的会话才能读」也不行：安全规则的 in
//   只支持常量，写不了 auth.openid in doc.members。
//
// 所以用云函数 + 轮询。代价是 2~3 秒延迟（聊天场景几乎无感），
// 换来权限完全可控、好调试。
//
// conversations / messages 两个集合的权限都设「仅管理端可读写」——
// 和 users / orders 一样，客户端一行都不直连。
//
// 统一返回格式：{ code: 0, message: 'ok', ... }，code !== 0 表示失败
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const CONV = 'conversations';
const MSG = 'messages';
const USERS = 'users';
const GOODS = 'goods';

// 部署版本号：每次改动 +1。
// 「不支持的操作：xxx」这个报错九成是云函数没部署成功、云端还跑着旧代码。
// 版本号必须出现在【失败】路径上 —— 装在成功返回里等于失明，
// 因为部署没生效时你恰恰在失败那一边，根本看不到它。
const CODE_VERSION = 2;

const MSG_MAX = 500; // 单条消息长度上限
const PULL_LIMIT = 30; // 单次拉取条数
const LIST_LIMIT = 50; // 会话列表最多返回条数
const MAX_TEXT_LEN = 2500; // msgSecCheck 单次上限

// ============================================================
// 聊天图片
// ============================================================
//
// 【只做图片，不做语音视频】—— 用户明确选的范围。
//   微信原生聊天组件能直接发语音视频，但那个组件会把消息存到微信那边，
//   本项目读不到，客服/审核都无从下手。这里的图片是走我们自己云存储的，
//   谁发的、什么时候发的、发给谁的，全在库里。
//
// ⚠️ 前缀要和 utils/cloud-config.js 的 CLOUD_PATH.CHAT_IMAGE 一致。
//    那边是客户端上传时用的目录，这边是服务端校验用的。
//    改一个不改另一个，症状是「图片永远发不出去」，而报错是
//    「不是有效的聊天图片」—— 听起来像用户的问题，其实是这两处没对上。
//    搜索 CHAT_IMAGE 能同时找到这两个地方。
const CHAT_IMAGE_PREFIX = 'chat/';

// imgSecCheck 的硬限制：图片要小于 1M。
// 超了接口直接报错，而报错会走到下面的「服务异常」分支 ——
// 用户看到的是「稍后重试」，重试多少次都一样。所以这里先自己拦下来，
// 给一句能照着做的提示。
// 客户端上传前有一次压缩 + 体积检查（chat.js 的 compressThenUpload），
// 正常情况下走不到这儿。
const IMG_CHECK_MAX = 1024 * 1024;

// 允许的图片后缀。imgSecCheck 只认 png/jpg/jpeg/gif/bmp 这几种，
// 白名单之外的（尤其是视频、音频文件）在这里就挡掉 ——
// 不然会拿一个 mp4 去调图片检测接口，报一个看不懂的错。
const IMG_EXT_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp'
};

// 校验聊天图片的 fileID，通过返回 { ok: true, contentType }，否则 { ok: false, message }
//
// 【为什么要白名单，不能只看「是个 fileID 就行」】
//   不校验的话，用户可以往 content 里塞任意 fileID —— 包括别人的头像、
//   商品图、甚至别的云环境的文件。消息是存库的，等于用聊天记录
//   当成了一个「任意云文件引用」的容器，将来谁也不知道里面会冒出什么。
//   锁死在自己的 chat/ 目录里，这一页里出现的东西就都是聊天图片。
//
// 【为什么还要精确到「自己这个会话的目录」】
//   光判 chat/ 是不够的，因为下面 sendImageMessage 在检测不通过时
//   会【删掉】这个文件 —— 只判 chat/ 的话，任何登录用户只要拿到
//   （或者猜到）别人聊天图片的 fileID，就能构造一次请求让服务端
//   把别人的图删了。文件删除是不可逆的，这个口子不能留。
//
//   客户端上传时的路径正是 chat/<会话ID>/<文件名>（见 chat.js 的
//   uploadAndSend）。而调用者是不是这个会话的成员，getConversationFor
//   在这一步之前【已经查过了】。所以把会话 ID 并进白名单，
//   就等于「只能操作自己参与的那些会话里的图」——
//   和删除这个动作的权限边界严丝合缝地对上了。
function validChatImageFile(fileID, conversationId) {
  const id = String(fileID || '').trim();

  // 只认云存储 fileID。https 外链一律不收：
  // 那会让聊天里出现任意站外图片，既没法审核也没法清理。
  if (id.indexOf('cloud://') !== 0) {
    return { ok: false, message: '只支持发送聊天里上传的图片' };
  }

  // fileID 形如 cloud://<环境>.<存储桶>/<路径>，取第一个 / 之后的部分当路径。
  const afterScheme = id.slice('cloud://'.length);
  const slash = afterScheme.indexOf('/');
  if (slash < 0) return { ok: false, message: '图片地址不合法' };

  const path = afterScheme.slice(slash + 1);

  // 【为什么是两个条件，而不是只判 startsWith】
  //   云存储 fileID 的路径段在不同环境/不同上传方式下，有的就是
  //   chat/xxx.png，有的前面还会再带一段环境标识。只判 startsWith
  //   会在后者上把【所有】正常图片都拒掉，而且报的是「不是聊天图片」，
  //   查半天查不出所以然。两种形状都放行，同时仍然挡掉
  //   goods/xxx.png、avatar/xxx.png 这些别的目录。
  const inChatDir = path.indexOf(CHAT_IMAGE_PREFIX) === 0 || path.indexOf('/' + CHAT_IMAGE_PREFIX) >= 0;
  if (!inChatDir) {
    return { ok: false, message: '只能发送聊天图片' };
  }

  // 会话目录必须对得上。这一段不能省，理由见上面第二段说明。
  if (path.indexOf(CHAT_IMAGE_PREFIX + conversationId + '/') < 0) {
    return { ok: false, message: '只能发送本次会话里上传的图片' };
  }

  const ext = (path.split('.').pop() || '').toLowerCase();
  const contentType = IMG_EXT_MIME[ext];
  if (!contentType) {
    return { ok: false, message: '图片格式不支持，请换一张' };
  }

  return { ok: true, contentType };
}

// 图片内容安全检测。
//
// 【和 checkContent 一样，一律 fail-closed】
//   接口异常、下载失败、体积不达标 —— 全部按「不让发」处理。
//   理由和文字检测那条一样：宁可让用户重发一次，
//   也不能让一张没检测过的图进到聊天记录里，
//   那是发出去就收不回来的东西。
async function checkImage(fileID, conversationId) {
  const valid = validChatImageFile(fileID, conversationId);
  if (!valid.ok) return { pass: false, code: 1, message: valid.message };

  let buffer;
  try {
    const res = await cloud.downloadFile({ fileID });
    buffer = res && res.fileContent;
  } catch (err) {
    console.error('下载聊天图片失败:', err);
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
    return { pass: true };
  } catch (err) {
    if (err && err.errCode === 87014) {
      return { pass: false, code: 87014, message: '图片涉嫌违规，请换一张' };
    }
    console.error('imgSecCheck error:', err);
    return { pass: false, code: -2, message: '图片安全检测服务异常，请稍后重试' };
  }
}

// 被拒绝的图片从云存储里删掉
//
// 【为什么必须删】
//   上传和检测是两步：客户端先把文件传上去拿到 fileID，再带着 fileID
//   来调 sendMessage。所以检测不过关的时候，文件【已经在存储里了】。
//   不删的话，存储里会慢慢攒下一堆没通过检测的图 ——
//   既占空间，也正是最不该留着的那一类东西。
//
//   删不掉只是记一条日志，不影响给用户的返回：他要重发，
//   重发会重新上传一份新的。删不掉是运维该看的事，不是用户该等的错。
//
// 【这里为什么还要再校验一次目录才动手】
//   sendImageMessage 在「校验没过」时也会调这里，而那种情况下
//   fileID 指向的可能是 goods/ 或 avatar/ 里的别人的文件。
//   删除是不可逆的，绝不能让一次构造出来的请求删掉别人的数据。
//   所以：目录对不上就【不删】，只记日志。
//   这是这个函数自己的一道门，不依赖调用方记得先校验。
async function deleteRejectedImage(fileID, conversationId) {
  const valid = validChatImageFile(fileID, conversationId);
  if (!valid.ok) {
    console.warn('拒绝删除非本会话目录下的文件，fileID=', fileID);
    return;
  }

  try {
    await cloud.deleteFile({ fileList: [fileID] });
  } catch (err) {
    console.warn('删除未通过的聊天图片失败，fileID=', fileID, err);
  }
}

// 取用户昵称头像（快照用）
//
// ⚠️【白名单：这个对象会被写进 conversations，然后给【聊天对端】看】
//    openConversation 拿它给双方各存一份，之后 listConversations /
//    pullMessages 返回的 peerName / peerAvatar 就是从这儿来的。
//    users 档案里的 realName（真实姓名）【绝不能】加进来 ——
//    真实姓名只有管理员和用户本人可见，聊天的对方也不行。
//    加字段前先问：这个值是要给陌生买家/卖家看的吗？
//
//    同一约束还在另外两处（也都是给「别人」造快照）：
//      cloudfunctions/publishGoods/index.js  buildPublisher
//      cloudfunctions/order/index.js         getUserBrief
//    搜索 realName 能同时找到这几个地方。
async function profileOf(openid) {
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

// 身份准入：调用者必须是【已完成核验】的用户（users.verified === true）。
//
// 【为什么聊天也要卡这道门】
//   前端那层（详情页「聊一聊」按钮的 guardVerified）是【体验】，
//   绕过小程序直接 callFunction 就跳过去了。私聊是两个真实用户之间的
//   点对点通道，未核验的账号不该有开通它的能力 ——
//   否则「学号 + 校内定位」这道门槛在聊天这条线上等于不存在。
//
//   （前端原来写的是「app.js 里那句『没有 verified 就 reLaunch 到注册页』」，
//    那句话 2026-10 已经去掉了 —— 启动时不再强制跳转，见 app.js 的说明。
//    现在前端拦在入口上，服务端这道门是唯一真正算数的。）
//
// 【为什么返回 { ok, err } 而不是直接返回 { code, message }】
//   下面 getConversationFor 用的就是这个结构，调用处
//   `if (!found.ok) return found.err;` 才能两边通用。
async function requireVerified(openid) {
  const res = await db
    .collection(USERS)
    .where({ _openid: openid })
    .limit(1)
    .get()
    .catch(() => null);
  const user = (res && res.data && res.data[0]) || null;
  if (!user || user.verified !== true) {
    return { ok: false, err: { code: 1, message: '请先完成校内身份核验' } };
  }
  return { ok: true, user };
}

// 内容安全检测：pass 放行，review / risky 拒绝；接口异常一律拒绝（绝不放行）
//
// 聊天是 UGC，微信【强制】要求接入 msgSecCheck，不接会被下架，
// 这不是「有空再优化」的选项。openid 传调用者（也就是发送者），
// 风控要靠它定位到人。
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
          ? '消息需要人工复核，请调整措辞后重试'
          : '消息涉嫌违规，请修改后重试'
    };
  } catch (err) {
    if (err && err.errCode === 87014) {
      return { pass: false, code: 87014, message: '消息涉嫌违规，请修改后重试' };
    }
    console.error('msgSecCheck error:', err);
    return { pass: false, code: -2, message: '内容安全检测服务异常，请稍后重试' };
  }
}

// 取会话并确认调用者确实是它的成员
//
// 这一步是【唯一的防线】。两个集合都设成「仅管理端可读写」，
// 客户端确实拿不到任何数据；但如果这里不校验，任何人构造一个
// conversationId 就能读到别人的聊天记录 —— 墙砌好了，门却没锁。
async function getConversationFor(conversationId, openid) {
  const id = String(conversationId || '').trim();
  if (!id) return { ok: false, err: { code: 1, message: '缺少会话 ID' } };

  const res = await db
    .collection(CONV)
    .doc(id)
    .get()
    .catch(() => null);

  const conv = res && res.data;
  if (!conv) return { ok: false, err: { code: 1, message: '会话不存在' } };

  if (conv.buyerOpenid !== openid && conv.sellerOpenid !== openid) {
    return { ok: false, err: { code: 1, message: '无权访问该会话' } };
  }

  return { ok: true, conv };
}

// 打开会话：没有就建一个，有就直接返回
async function openConversation(openid, event) {
  const goodsId = String(event.goodsId || '').trim();
  if (!goodsId) return { code: 1, message: '缺少商品 ID' };

  const goodsRes = await db
    .collection(GOODS)
    .doc(goodsId)
    .get()
    .catch(() => null);

  const goods = goodsRes && goodsRes.data;
  if (!goods) return { code: 1, message: '商品不存在或已被删除' };

  const sellerOpenid = goods._openid;
  if (!sellerOpenid) return { code: 1, message: '这个商品缺少卖家信息' };
  if (sellerOpenid === openid) return { code: 1, message: '不能和自己聊天' };

  // 同一个人 + 同一件商品 = 同一个会话，不重复建
  const exist = await db
    .collection(CONV)
    .where({ goodsId, buyerOpenid: openid, sellerOpenid })
    .limit(1)
    .get();

  if (exist.data && exist.data.length) {
    return { code: 0, message: 'ok', conversationId: exist.data[0]._id };
  }

  const [buyer, seller] = await Promise.all([profileOf(openid), profileOf(sellerOpenid)]);
  const now = new Date();

  const doc = {
    // 云函数 add 不会自动写 _openid，必须手动带。
    // 不带的话这条记录的归属就是空的，以后任何按 _openid 的查询都找不到它。
    _openid: openid,
    goodsId,
    // 商品快照：会话列表要显示「当初聊的是哪个东西」，
    // 而商品随时可能被下架删除，到时候现查就查不到了。
    // 和 goods 里存 publisher 快照是同一个道理。
    goodsTitle: goods.title || '',
    goodsImage: (goods.images && goods.images[0]) || '',
    goodsPrice: goods.price || 0,
    buyerOpenid: openid,
    buyerName: buyer.nickname,
    buyerAvatar: buyer.avatar,
    sellerOpenid,
    sellerName: seller.nickname,
    sellerAvatar: seller.avatar,
    lastMessage: '',
    lastTime: now,
    lastSenderOpenid: '',
    buyerUnread: 0,
    sellerUnread: 0,
    createTime: now,
    updateTime: now
  };

  const res = await db.collection(CONV).add({ data: doc });
  return { code: 0, message: 'ok', conversationId: res._id };
}

// 我的会话列表
async function listConversations(openid) {
  const res = await db
    .collection(CONV)
    .where(_.or([{ buyerOpenid: openid }, { sellerOpenid: openid }]))
    .orderBy('updateTime', 'desc')
    .limit(LIST_LIMIT)
    .get();

  let unreadTotal = 0;

  const list = (res.data || []).map((c) => {
    // 同一条会话记录，对买卖双方要显示【对方的】名字头像、和【自己的】未读数。
    // 存一份、按身份分叉，比给每个人各存一条会话记录省事得多。
    const isBuyer = c.buyerOpenid === openid;
    const unread = (isBuyer ? c.buyerUnread : c.sellerUnread) || 0;
    unreadTotal += unread;

    return {
      id: c._id,
      goodsId: c.goodsId,
      goodsTitle: c.goodsTitle,
      goodsImage: c.goodsImage,
      goodsPrice: c.goodsPrice,
      peerName: isBuyer ? c.sellerName : c.buyerName,
      peerAvatar: isBuyer ? c.sellerAvatar : c.buyerAvatar,
      lastMessage: c.lastMessage || '',
      lastTime: c.lastTime,
      unread
    };
  });

  return { code: 0, message: 'ok', list, unreadTotal };
}

// 拉消息
//
// since 为空 = 首屏：取【最近】的 N 条，所以要倒序取再翻转。
//   正序取会拿到这个会话【最早】的 30 条，而那多半是几个月前
//   的「你好还在吗」—— 用户一进聊天页看到的不是最近的对话。
// since 有值 = 增量：只取比它新的，正序取正好。
async function pullMessages(openid, event) {
  const found = await getConversationFor(event.conversationId, openid);
  if (!found.ok) return found.err;

  const since = Number(event.since) || 0;
  let query;

  if (since > 0) {
    query = db
      .collection(MSG)
      .where({ conversationId: found.conv._id, createTime: _.gt(new Date(since)) })
      .orderBy('createTime', 'asc')
      .limit(PULL_LIMIT);
  } else {
    query = db
      .collection(MSG)
      .where({ conversationId: found.conv._id })
      .orderBy('createTime', 'desc')
      .limit(PULL_LIMIT);
  }

  const res = await query.get();
  let list = res.data || [];
  if (since <= 0) list = list.slice().reverse(); // 倒序取的要翻回来

  return {
    code: 0,
    message: 'ok',
    list: list.map((m) => ({
      id: m._id,
      content: m.content,
      type: m.type || 'text',
      // 图片消息的云存储地址。老消息没有这个字段，读出来是 undefined，
      // 前端只在 type === 'image' 时才用它 —— 而老消息的 type 一定是 text，
      // 所以不需要给历史数据补字段。
      fileID: m.fileID || '',
      // 前端拿不到自己的 openid 也没关系 —— 服务端直接告诉她
      // 「这条是不是你发的」，前端不用自己判断身份，
      // 气泡该靠左还是靠右就有着落了。
      isMine: m._openid === openid,
      createTime: m.createTime
    })),
    // 会话对端 + 商品信息，聊天页顶部和商品卡片要用
    peerName:
      found.conv.buyerOpenid === openid ? found.conv.sellerName : found.conv.buyerName,
    peerAvatar:
      found.conv.buyerOpenid === openid ? found.conv.sellerAvatar : found.conv.buyerAvatar,
    goodsId: found.conv.goodsId,
    goodsTitle: found.conv.goodsTitle,
    goodsImage: found.conv.goodsImage,
    goodsPrice: found.conv.goodsPrice
  };
}

// 发消息
//
// 两种类型，走同一个入口：
//   type: 'text'  → content 是文字，过 msgSecCheck
//   type: 'image' → fileID 是云存储地址，过 imgSecCheck
// 两条路的共同点是【都必须先过内容安全检测才落库】。
async function sendMessage(openid, event) {
  const found = await getConversationFor(event.conversationId, openid);
  if (!found.ok) return found.err;

  // 不传 type 就按文字算 —— 老版本客户端不会传这个字段，
  // 默认成 text 它们的行为才和升级前一模一样。
  const type = event.type === 'image' ? 'image' : 'text';

  if (type === 'image') {
    return await sendImageMessage(openid, found.conv, event);
  }
  return await sendTextMessage(openid, found.conv, event);
}

// 发文字
async function sendTextMessage(openid, conv, event) {
  const content = String(event.content || '').trim();
  if (!content) return { code: 1, message: '消息不能为空' };
  if (content.length > MSG_MAX) {
    return { code: 1, message: '消息不能超过 ' + MSG_MAX + ' 个字' };
  }

  const check = await checkContent(content);
  if (!check.pass) return { code: check.code, message: check.message };

  return await writeMessage(openid, conv, {
    content,
    type: 'text',
    // 会话列表里显示的那一行摘要
    summary: content.slice(0, 50)
  });
}

// 发图片
async function sendImageMessage(openid, conv, event) {
  const fileID = String(event.fileID || '').trim();
  if (!fileID) return { code: 1, message: '图片地址为空，请重发一次' };

  const check = await checkImage(fileID, conv._id);
  if (!check.pass) {
    // 没通过就把已经传上去的那份删掉，别让它留在存储里。
    //
    // 【为什么这里删是安全的】
    //   validChatImageFile 已经确认过这个 fileID 就在
    //   chat/<本会话ID>/ 目录下，而调用者的会话成员身份
    //   getConversationFor 在前面查过了。
    //   所以能走到这一行，最坏情况也只是删掉自己参与的那个会话里的图。
    //   少了那道会话目录校验，这里就是一个「拿到任意 fileID
    //   就能删别人文件」的口子 —— 删除不可逆，所以那道校验不能省。
    //
    // 【为什么连「不是聊天图片」这种没通过校验的也删】
    //   那种情况下 fileID 指向别的目录，删掉会影响别人的数据 ——
    //   所以下面 deleteRejectedImage 里还会再判一次目录，
    //   校验没过的一律不删。见那个函数。
    await deleteRejectedImage(fileID, conv._id);
    return { code: check.code, message: check.message };
  }

  return await writeMessage(openid, conv, {
    // 图片消息的 content 留空：内容是图片本身，硬塞一个
    // 「[图片]」进 content 字段的话，将来想按文字内容做统计或
    // 检索就会被这三个字污染。列表里显示什么是渲染的事，
    // 由下面的 summary 负责。
    content: '',
    type: 'image',
    fileID,
    summary: '[图片]'
  });
}

// 落库 + 更新会话（文字和图片共用的收尾）
//
// 【为什么抽出来】：上面两条路除了「存什么」以外，
// 后面这一整套（写消息、摘要、未读、排序）【必须完全一致】——
// 图片消息要是漏了未读 +1，对方就永远收不到红点，
// 而这种 bug 只在发图片时出现，最容易在上线后才被发现。
async function writeMessage(openid, conv, payload) {
  const now = new Date();

  // 把 _id 返回给前端：她可以立刻把这条消息插进列表，
  // 不用干等下一轮轮询。而轮询回来时靠 _id 去重，不会显示两遍。
  // 不返回的话，自己发的消息要等 2~3 秒才出现，
  // 用户会以为没发出去，然后再点一次发送。
  const doc = {
    _openid: openid, // 同 openConversation，必须手动写
    conversationId: conv._id,
    content: payload.content,
    type: payload.type,
    createTime: now
  };
  // messages 集合是【无 schema】的，加字段不需要迁移脚本 ——
  // 老消息没有 fileID 这个字段，读出来是 undefined，
  // 前端按 type 分支渲染，碰不到它。
  if (payload.fileID) doc.fileID = payload.fileID;

  const addRes = await db.collection(MSG).add({ data: doc });

  const isBuyer = conv.buyerOpenid === openid;

  // 一次 update 更新三组字段，避免多次写：
  //   lastMessage / lastTime —— 会话列表的摘要和排序依据
  //   对方未读 +1            —— 用原子自增 _.inc，不读出来再加，防并发覆盖
  //   自己未读清零           —— 人在聊天页里，说明都看到了
  await db
    .collection(CONV)
    .doc(conv._id)
    .update({
      data: {
        lastMessage: payload.summary,
        lastTime: now,
        lastSenderOpenid: openid,
        updateTime: now,
        [isBuyer ? 'sellerUnread' : 'buyerUnread']: _.inc(1),
        [isBuyer ? 'buyerUnread' : 'sellerUnread']: 0
      }
    });

  return {
    code: 0,
    message: 'ok',
    _id: addRes._id,
    createTime: now.getTime(),
    // 前端拿这个直接往列表里插，不用自己拼
    content: payload.content,
    type: payload.type,
    fileID: payload.fileID || ''
  };
}

// 标记已读
async function markRead(openid, event) {
  const found = await getConversationFor(event.conversationId, openid);
  if (!found.ok) return found.err;

  const isBuyer = found.conv.buyerOpenid === openid;
  await db
    .collection(CONV)
    .doc(found.conv._id)
    .update({ data: { [isBuyer ? 'buyerUnread' : 'sellerUnread']: 0 } });

  return { code: 0, message: 'ok' };
}

// 未读总数（「我的」页面上的红点用）
async function unreadTotal(openid) {
  const res = await listConversations(openid);
  return { code: 0, message: 'ok', unreadTotal: res.unreadTotal || 0 };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const action = (event && event.action) || '';

  try {
    // 【V-04 修复】会「建立通道 / 产生内容」的两个动作先过身份准入。
    //
    // 【为什么只卡这两个，不卡全部】
    //   listConversations / pullMessages / markRead / unreadTotal 是
    //   只读或清未读，成员校验（getConversationFor）已经保证只有会话
    //   双方能碰；再压一道核验，只会让已完成核验的老用户被历史脏数据挡住。
    //   而 openConversation（建通道）和 sendMessage（产生内容）是
    //   把未核验账号引入业务的动作，这两处必须卡住。
    if (action === 'openConversation' || action === 'sendMessage') {
      const gate = await requireVerified(OPENID);
      if (!gate.ok) return gate.err;
    }

    switch (action) {
      case 'openConversation':
        return await openConversation(OPENID, event);
      case 'listConversations':
        return await listConversations(OPENID);
      case 'pullMessages':
        return await pullMessages(OPENID, event);
      case 'sendMessage':
        return await sendMessage(OPENID, event);
      case 'markRead':
        return await markRead(OPENID, event);
      case 'unreadTotal':
        return await unreadTotal(OPENID);
      default:
        return {
          code: -1,
          message: '不支持的操作：' + action + '（云端版本 v' + CODE_VERSION + '）'
        };
    }
  } catch (err) {
    console.error('chat error:', action, err);
    return { code: -1, message: '操作失败：' + err.message };
  }
};
