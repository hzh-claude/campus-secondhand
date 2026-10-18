// cloudfunctions/user/index.js
// 用户中心云函数：读取档案、更新档案、统计计数
//
// 为什么这些操作不直连数据库？
//   1. users 是私有数据，goods 统计必须限定「只有我的」，
//      涉及身份判断的操作一律走云函数——OPENID 由微信背书，前端伪造不了；
//   2. 更新档案要做服务端校验（昵称长度、手机号格式、宿舍白名单），
//      前端校验只是体验优化，不能当防线。
//
// 统一返回格式：{ code: 0, message: 'ok', ... }，code !== 0 表示失败
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const USERS = 'users';
const GOODS = 'goods';
const ORDERS = 'orders';

// 学号占用登记表：文档 _id 直接就是学号本身。
// 用来保证「一个学号只能被一个账号注册」，原理见 claimStudentId。
const STUDENT_IDS = 'student_ids';

// 部署版本号：每次改动都 +1，随返回值一起发给前端。
// 排查「改了代码但没生效」这类问题时，靠界面上的版本号一眼就能确认
// 云端跑的到底是新代码还是旧代码——比翻部署时间可靠。
const CODE_VERSION = 19;

// 商品状态：已卖出（与 utils/cloud-config.js 的 GOODS_STATUS.SOLD 保持一致）
const STATUS_SOLD = 'sold';

// 订单状态：已完成（与 utils/cloud-config.js 的 ORDER_STATUS.COMPLETED 保持一致）
const ORDER_COMPLETED = 'completed';

// 宿舍白名单：服务端必须有一份自己的合法值列表，
// 不能信任前端传来的任意字符串，否则用户能把自己宿舍改成任何内容
const CAMPUS_LIST = ['荷园', '松园', '桃园', '竹园'];

const NICKNAME_MAX = 20;
const WECHAT_MAX = 30;

// 真实姓名的长度上限。
//
// ⚠️ 必须和 utils/cloud-config.js 里的 REAL_NAME_MAX 一致！
//    云函数独立部署、require 不到那个文件，只能两处各写一份。
//    搜索 REAL_NAME_MAX 能同时找到这两个地方。
//
// 【只校验长度，不校验字符】
//    不要给这个字段加「必须是 2-4 个汉字」这类正则。少数民族姓名、
//    外文名、带空格的复姓都会被误伤，而这里是注册的必经之路 ——
//    被误伤的人根本注册不了，且报错信息只会让他觉得自己名字有问题。
const REAL_NAME_MAX = 20;

// 学号规则：12 位数字，前 4 位是入学年份（例：202409050125 → 2024 级）
const STUDENT_ID_LEN = 12;

// 入学年份下限。【写死这一头】是因为「从哪一届开始算」是个业务决定，
// 不会自己变 —— 2021 级及以前（已经毕业）不在本次范围内。
//
// 【2026-10 从 2023 放宽到 2022】
//   原来卡在 2023，是照「今年在校的四个年级」定的：2023 级大一
//   ~ 2026 级大一。放开到 2022 之后，2022 级（大四/刚毕业）也能注册。
//   这个数只影响【注册】那道门，不影响已经注册过的人 ——
//   编辑资料时学号是选填，老用户改昵称不会被这个下限拦住。
const STUDENT_ID_MIN_YEAR = 2022;

// 上限【不写死】，取当前年份。
// 曾经想过写死成 2026，但那是个会自己过期的规则：
// 2027 年 9 月新生入学时会发现学号填不进去，而那时候
// 写这行代码的人（你）多半已经不记得有这个地方了。
// 用当前年份，每年自动放行新生，不用改代码、不用重新部署。

// ============================================================
// 注册闸门：学校坐标 + 允许半径
// ============================================================
//
// 这对坐标【只存在于服务端】。前端只上报「我在哪」，
// 由这里裁决「够不够近」——
// 规则要是写在前端，改一行 JS 就能把自己判成在校内。
//
// 【V-03 修复】坐标与半径改为「环境变量优先，源码值兜底」。
//
// 【为什么要动它】
//   原值只写在源码里，意味着：任何拿到这份代码的人都直接知道
//   「填哪个坐标能过核验」—— 伪造成本被源码本身降到了零，
//   而改一个数字必须重新部署云函数（还要走一遍开发流程）。
//   变成环境变量后，两者都好转：改值不用碰代码，
//   而"源码里那个值能通吃"这件事不再成立（改过环境变量后，
//   旧坐标立即失效，攻击者拿到的公开值是过期的）。
//
// 默认值仍是湖南科技学院（湖南省永州市零陵区杨梓塘路130号），
// 取自腾讯位置服务坐标拾取器。格式是「纬度,经度」—— 纬度在前。
// 抄反的后果不是报错，是所有人都被判成「不在校内」（跑缅甸去了），
// 而现象跟「定位接口坏了」一模一样。填完记得核一眼：纬度该在 20~50 之间（中国）。
//
// 配置位置：云开发控制台 → 云函数 → user → 配置 → 环境变量
//   可配项：SCHOOL_LAT / SCHOOL_LNG / ALLOW_RADIUS_M / MIN_DISTANCE_M
function readEnvNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const SCHOOL_LAT = readEnvNumber('SCHOOL_LAT', 26.205311);
const SCHOOL_LNG = readEnvNumber('SCHOOL_LNG', 111.606371);

// 允许半径（米）。
//
// 【3000 → 10000（10-14）→ 5000（10-15）→ 4000（10-16），起因是一次真机实测】
//
//   人站在学校里，真机测出来 3.6 公里 —— 直接超过 3000，注册被拒。
//   这 3.6 公里是这么构成的：
//     ~0.65 公里  坐标系不匹配（前端 getFuzzyLocation 没传 type，
//                 默认 wgs84，学校坐标却是 gcj02）。已在 utils/location.js 修掉。
//     ~3   公里  模糊定位本身的误差。
//
//   关键认知：【getFuzzyLocation 根本不调 GPS】。它用的是基站 + WiFi + IP
//   的网络定位，微信还会再主动做一层模糊化偏移。所以它的误差不是
//   「几米」这个量级，而是「几百米到几公里」，郊区基站稀就更差。
//
//   于是原来那个 3000 米等于把阈值设在了误差的【正中间】——
//   真学生过不过全看当天的运气。这不是「偶尔误伤」，是抛硬币。
//
// 【这个数被改过四次，每次的理由都记下来】
//   3000 → 10000（2026-10-14）：先止血。坐标系 bug 修好之前谁也不知道
//     真实误差是多少，先给一个绝对安全的值，让真学生先能注册上。
//   10000 → 5000（2026-10-15）：10000 米 = 10 公里，那个圈盖住永州零陵区
//     大半 —— 校内核验基本等于没做。**出血停了就得把口子收回来**，
//     否则会误以为这道校验本来就不起作用、甚至把它删掉。
//   5000 → 4000（2026-10-16）：隐私指引过审、接口权限恢复后收紧一档。
//
//   ⚠️ 4000 的依据只有【一次】实测：3.6 公里那次里坐标系那 0.65 公里是
//      bug（已修），真实误差约 3 公里。4000 在它之上只留了约 1 倍余量 ——
//      **比 5000 时的 1.6 倍更薄**。这是一个折中，不是「算出来的最优值」：
//        再往上放 → 挡不住市区里根本没进校门的人（核验形同虚设）
//        再往下收 → 误差偏大那天又会误伤真学生
//      所以这个数【应该靠实测校准，不是靠推理】—— 见下面的「怎么调」。
//      ⚠️ 一个数据点不足以定阈值，它只说明「误差确实可能到这个量级」。
//      在那之前，宁可偶尔误伤也不要放进明显不在校内的人：
//      误伤的人【提交后能看到云函数的距离提示，还能重试】；
//      放进来的人【永远不会被发现】，而这是不可逆的。
//
// 【放宽之后它拦的是什么】
//   大概率的「永州零陵区及周边」以外的外地人，不是「校园围墙外」的人。
//   但本来也拦不住存心伪造的人 —— 客户端报上来的经纬度没法证明。
//   真正把关学生身份的是【学号唯一性 + 真实姓名】，
//   定位这一层只是个「挡掉明显外地人」的粗筛，不值得为它误伤真学生。
//
// 怎么调：看云函数日志里那句 距离=xxxx 允许=yyyy 下限=zzzz，
//   真机在宿舍、教学楼各测几次，取【最大值】再往上留余量。
// 【V-03 修复】同样支持环境变量覆盖（ALLOW_RADIUS_M），
// 免得"怎么伪造"随着源码一起外流，也免得调参要重新部署。
//
// ⚠️ 环境变量优先于这里的默认值。排查半径问题时，
//    第一件事是去控制台看有没有设 ALLOW_RADIUS_M，别只看源码。
const ALLOW_RADIUS_M = readEnvNumber('ALLOW_RADIUS_M', 4000);

// 【V-09】距学校坐标的【下限】（米）。
//
// 模糊定位误差是公里级，真学生几乎不可能刚好钉在腾讯地图拾取器
// 那个点上（误差反而会把人扔到半径里的某处）。
// 距离小到这个数，说明请求里的经纬度就是学校配置点本身 ——
// 这是「从源码 / 前端包抄坐标填进 callFunction」的典型样子。
//
// ⚠️ 这挡的是「原样粘贴学校坐标」，不是「在半径里随机偏一点」。
//    微信云函数拿不到官方 GPS，客户端传来的数字没法密码学证明。
//    正常真机定位不受影响：getFuzzyLocation 照旧，半径仍是 ALLOW_RADIUS_M。
//    （这里原来写的是「半径仍是 3000 米」，是 3000 那个年代留下的 ——
//      凡是文中写死具体数字的地方，改常量时一定要一起搜一遍。）
const MIN_DISTANCE_M = readEnvNumber('MIN_DISTANCE_M', 30);

// 【开发期开关 —— 已关闭，定位核验现在是生效的】
//
// 为什么当初需要它：定位权限要去公众平台后台申请，审核要时间。
// 权限没下来之前，定位调用直接失败 —— 而这是「强制重新注册」的流程，
// 那意味着【你自己也会被挡在注册页外】，连自家小程序都进不去。
// 有了它，就能先关掉定位校验把注册流程跑通。
//
// 【2026-10-03 改成 false】
//   wx.getFuzzyLocation 的接口权限已开通（开发管理 → 接口设置），
//   隐私保护指引里的「地理位置」也已勾选，所以这里具备了开启条件。
//
// 【什么时候可以再打开它】
//   只有一种情况：你又要动注册流程、而定位接口临时不可用，
//   得先把自己放进去调。除此之外【不要】打开 ——
//   打开后外地人也能注册，而且是【静默】放行的，
//   日志里只有一行 ⚠️，界面上一点异常都没有，很容易忘了它还开着。
const DEV_SKIP_LOCATION = false;

// 查当前用户的档案，没有则返回 null
async function findUser(openid) {
  const res = await db
    .collection(USERS)
    .where({ _openid: openid })
    .limit(1)
    .get();
  return (res.data && res.data[0]) || null;
}

// 档案不存在时的默认值（纯读接口用，不写库，避免读操作产生副作用）
//
// ⚠️ 这里必须【把字段列全】，不能只列常用的几个。
//    它返回的 user 会被前端直接拿去渲染（「我的」页、编辑资料页），
//    漏一个字段的后果是页面上出现 undefined —— 而「档案不存在」
//    恰恰是新用户最常见的状态，所以漏字段一定会被发现，只是发现得晚。
function defaultProfile(openid) {
  return {
    _openid: openid,
    nickname: '校园用户',
    avatar: '',
    campus: '',
    studentId: '',
    realName: '',
    phone: '',
    wechat: ''
  };
}

// 两个经纬度之间的距离（米）
//
// haversine 公式：把地球当正球面，算两点间的大圆距离。
// 球面近似在这个尺度上的误差不到 0.5%（3 公里差十几米），
// 判断「在不在校内」绰绰有余，不需要上更复杂的椭球模型。
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000; // 地球平均半径（米）
  const toRad = (deg) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  // a 必然落在 [0,1]，所以 asin(sqrt(a)) 不会出 NaN
  return 2 * R * Math.asin(Math.sqrt(a));
}

// 解析并核验客户端报来的经纬度。
// previewLocation 和 register 共用，改规则只改这一处。
//
// 返回 { ok, message, distance, inRange, spoofPin }
function evaluateCampusLocation(lat, lng) {
  if (!SCHOOL_LAT || !SCHOOL_LNG) {
    return { ok: false, message: '服务端未配置学校坐标，无法核验位置' };
  }

  const latOk = isFinite(lat) && lat >= -90 && lat <= 90;
  const lngOk = isFinite(lng) && lng >= -180 && lng <= 180;

  if (!isFinite(lat) || !isFinite(lng) || (!lat && !lng)) {
    return { ok: false, message: '没能获取到你的位置，请允许定位后重试' };
  }
  if (!latOk || !lngOk) {
    return { ok: false, message: '定位数据异常，请重新获取位置后再试' };
  }

  const distance = distanceMeters(lat, lng, SCHOOL_LAT, SCHOOL_LNG);

  if (distance < MIN_DISTANCE_M) {
    return {
      ok: false,
      message: '定位数据异常，请重新获取位置后再试',
      distance,
      spoofPin: true
    };
  }

  if (distance > ALLOW_RADIUS_M) {
    return {
      ok: false,
      message:
        '你当前不在学校范围内（相距约 ' +
        Math.round(distance / 1000) +
        ' 公里），暂时无法注册',
      distance,
      inRange: false
    };
  }

  return { ok: true, distance, inRange: true };
}

// 校验并整理待更新字段
// 返回 { ok: true, data } 或 { ok: false, message }
function validateProfile(input) {
  const data = {};

  // 昵称：必填
  const nickname = String(input.nickname || '').trim();
  if (!nickname) return { ok: false, message: '请输入昵称' };
  if (nickname.length > NICKNAME_MAX) {
    return { ok: false, message: '昵称不能超过' + NICKNAME_MAX + '个字' };
  }
  data.nickname = nickname;

  // 真实姓名：选填，但【填了就必须合法】
  //
  // 和学号同一个模式（见下面 studentId 那段）：这份校验是「编辑资料」
  // 和「注册」共用的。老用户的档案是 login 云函数自动建的，里面
  // realName 是空的；如果这里改成必填，他们下次改个昵称都会被拦下来
  // 要求先补真名 —— 一个跟昵称毫无关系的操作被卡住，用户只会觉得
  // 「保存坏了」。真正的「必须填真名」是注册流程那道闸门的事。
  //
  // 【只校验长度，不校验字符】理由见文件顶部 REAL_NAME_MAX 的说明。
  const realName = String(input.realName || '').trim();
  if (realName.length > REAL_NAME_MAX) {
    return { ok: false, message: '姓名不能超过' + REAL_NAME_MAX + '个字' };
  }
  data.realName = realName;

  // 头像：允许云存储 fileID 或 https 链接，也允许留空
  const avatar = String(input.avatar || '').trim();
  if (avatar && avatar.indexOf('cloud://') !== 0 && avatar.indexOf('https://') !== 0) {
    return { ok: false, message: '头像地址不合法' };
  }
  data.avatar = avatar;

  // 宿舍：必须是白名单里的值，允许留空
  const campus = String(input.campus || '').trim();
  if (campus && CAMPUS_LIST.indexOf(campus) === -1) {
    return { ok: false, message: '宿舍不在可选范围内' };
  }
  data.campus = campus;

  // 学号：选填，但【填了就必须合法】
  //
  // 「选填」是给老用户留的活路：他们的档案是 login 云函数自动建的，
  // 里面 studentId 是空字符串。如果这里改成必填，他们下次改个昵称
  // 都会被拦下来要求先补学号 —— 一个跟昵称毫无关系的操作被卡住，
  // 用户只会觉得「保存坏了」。
  // 真正的「必须填学号」是注册流程那道闸门的事，不是这里。
  const studentId = String(input.studentId || '').trim();
  if (studentId) {
    if (!/^\d+$/.test(studentId) || studentId.length !== STUDENT_ID_LEN) {
      return { ok: false, message: '学号必须是 ' + STUDENT_ID_LEN + ' 位数字' };
    }
    const enrollYear = Number(studentId.slice(0, 4));
    const maxYear = new Date().getFullYear();
    if (enrollYear < STUDENT_ID_MIN_YEAR || enrollYear > maxYear) {
      return {
        ok: false,
        message:
          '学号前 4 位应为入学年份（' + STUDENT_ID_MIN_YEAR + '-' + maxYear + '）'
      };
    }
  }
  data.studentId = studentId;

  // 手机号：选填，填了就必须合法
  const phone = String(input.phone || '').trim();
  if (phone && !/^1[3-9]\d{9}$/.test(phone)) {
    return { ok: false, message: '手机号格式不正确' };
  }
  data.phone = phone;

  // 微信号：选填
  const wechat = String(input.wechat || '').trim();
  if (wechat.length > WECHAT_MAX) {
    return { ok: false, message: '微信号不能超过' + WECHAT_MAX + '个字' };
  }
  data.wechat = wechat;

  return { ok: true, data };
}

// 「我的」页面：档案 + 统计，一次调用全拿回，省一次网络往返
async function getHomeData(openid) {
  const user = await findUser(openid);

  // 三个 count 互不依赖，并行发出
  const [publishedRes, soldRes, boughtRes] = await Promise.all([
    db.collection(GOODS).where({ _openid: openid }).count(),
    db.collection(GOODS).where({ _openid: openid, status: STATUS_SOLD }).count(),
    // 「买到」= 我作为买家的、【已完成】的订单数。
    // 为什么只算 completed？待确认和已关闭的订单都还没真的买到东西，
    // 把它们算进去，数字会比实际交易量大。
    db
      .collection(ORDERS)
      .where({ _openid: openid, status: ORDER_COMPLETED })
      .count()
  ]);

  return {
    code: 0,
    message: 'ok',
    user: user || defaultProfile(openid),
    stats: {
      published: publishedRes.total || 0,
      sold: soldRes.total || 0,
      bought: boughtRes.total || 0
    }
  };
}

// 编辑页：只取档案，不做统计
async function getProfile(openid) {
  const user = await findUser(openid);
  return {
    code: 0,
    message: 'ok',
    // 【这条 v 是给「新字段为什么不回显」用的】
    //   这是【读】的那条路。只有写操作带版本号的话，读出来是空的时候
    //   你没法区分两种完全不同的原因：
    //     ① 库里就没有这个字段（老数据 / 注册时被旧版代码丢了）
    //     ② 云端跑的是旧版本，新字段根本没参与读写
    //   一个是「去补数据」，一个是「去重新部署」，方向完全相反。
    //   带上 v 之后，在调试器 Console 里一眼就能分流。
    v: CODE_VERSION,
    user: user || defaultProfile(openid)
  };
}

// 把新的头像昵称同步到该用户已发布的商品上
//
// 商品记录里的 publisher 是发布那一刻的快照（publishGoods 里做的），
// 好处是列表页直连数据库一次查询就能拿到卖家信息；
// 代价是用户改完资料后，旧商品还挂着旧头像旧昵称，需要在这里补一次同步。
//
// 用 where + update 批量改，不管有多少件商品都只发一次写请求；
// 但商品数量很大时这仍是一次重操作，将来商品多了可以改成异步任务。
//
// 这里【故意不吞异常】：调用方需要知道同步成功还是失败。
// 之前用 try/catch 只打日志，结果同步没生效时界面和日志都看不出异常，
// 排查时完全没有线索 —— 静默失败比直接报错难查得多。
//
// 返回被更新的条数，用来区分两种失败：
//   「更新成功了但匹配到 0 条」和「抛异常」，原因完全不同。
async function syncGoodsSnapshot(openid, profile, now) {
  // ⚠️【只同步 avatar 和 nickname，绝不能加 realName】
  //
  //    publisher 这个快照是写进 goods 集合的，而 goods 是【公开可读】的
  //    （首页/分类/搜索/详情都是客户端直连 goods）。往这里塞任何东西，
  //    等于对所有微信用户公开。真实姓名只有管理员和用户本人可见 ——
  //    一旦同步进去，删都删不干净（已发布商品的副本会一直挂着）。
  //
  //    取舍上也是对的：用户改昵称，正是因为他想在商品页换个名字。
  //    真名从头到尾就不该出现在商品页。
  const res = await db
    .collection(GOODS)
    .where({ _openid: openid })
    .update({
      data: {
        'publisher.avatar': profile.avatar || '',
        'publisher.nickname': profile.nickname || '校园用户',
        updateTime: now
      }
    });

  return (res && res.stats && res.stats.updated) || 0;
}

// 保存档案：有则更新，无则新建
async function updateProfile(openid, event) {
  const check = validateProfile(event);
  if (!check.ok) {
    return { code: -1, message: check.message };
  }

  const now = new Date();
  const existing = await findUser(openid);

  // ============================================================
  // 学号与真实姓名：注册后锁死
  // ============================================================
  // 【为什么锁在这儿，而不是只把前端输入框变灰】
  //   前端的置灰、隐藏【都不是安全边界】—— 直接 callFunction 就绕过去了。
  //
  //   而且这里原来确实是个洞：这一页能改学号，改的时候【没走
  //   claimStudentId】，等于绕开了学号唯一性检查 —— 别人的学号随便填，
  //   照样存得进去（claimStudentId 只在 registerStudent 里调）。
  //   真名同理：它是核验的一部分，能随手改掉，这个字段对管理员就等于不存在。
  //
  // 【所以这两个字段现在只有 registerStudent 能写】
  //   编辑资料页不再提交它们，云函数这边也不接受它们被改。
  //   想改 = 走客服（前端那句提示就是指向 pages/concat）。
  //
  // 【为什么要报错，而不是静默忽略】
  //   静默忽略会造出最难查的一类故障：用户改完点保存，界面回「保存成功」，
  //   下次进来又变回旧值 —— 他只会以为程序坏了，而且完全不知道从哪查起。
  //   这里直接说清楚：改不了，以及去哪儿改。
  //
  // 【为什么拿 event 比，而不是 check.data】
  //   validateProfile 是「编辑资料」和「注册」共用的，它会把没传的字段
  //   也整理成空字符串。于是「根本没提交这个字段」和「提交了一个空值」
  //   在 check.data 里长得一模一样 —— 而前者是正常的（新前端不再提交它），
  //   后者才是「想把学号擦掉」。要比就得比 raw event。
  const currentStudentId = String((existing && existing.studentId) || '');
  const currentRealName = String((existing && existing.realName) || '');

  // 没传 = 不改（新前端就是这么发的）；传了但和库里一样 = 也没改。
  // 老前端会把这两个字段原样带回来，所以上面第二条不能少。
  const changedStudentId =
    event.studentId !== undefined && String(event.studentId).trim() !== currentStudentId;
  const changedRealName =
    event.realName !== undefined && String(event.realName).trim() !== currentRealName;

  if (changedStudentId || changedRealName) {
    return {
      code: -1,
      message: '学号和真实姓名注册后不能修改，如需修改请联系客服',
      v: CODE_VERSION
    };
  }

  // 再删一道。就算上面那两行判断哪天被人改坏了，这两个字段也进不了写库的数据：
  // 先删，再写。这样最坏结果只是「改了但没生效」——安全；
  // 反过来（不该改的字段被写进去）才是不可挽回的那种。
  delete check.data.studentId;
  delete check.data.realName;

  if (existing) {
    await db.collection(USERS).doc(existing._id).update({
      data: Object.assign({}, check.data, { updatedAt: now })
    });

    // 无条件同步商品快照，不做「只在变化时同步」的判断。
    //
    // 曾经为了省一次批量写加过 change-detection，结果是个坑：
    // 商品快照一旦因为任何原因变成脏数据，用户再点一次保存也修不好
    // （昵称没变 → 判定不需要同步 → 脏数据永远留在那里）。
    // 保存资料本来就是低频操作，多一次批量写的代价，
    // 换来的是「重新保存一次就能修复」这个可靠的兜底手段。
    //
    // 同步失败不连累档案：档案已经存好了，这里把失败信息回传给前端，
    // 让用户知道「资料存了、但商品快照没跟上」，而不是假装一切正常。
    let synced = 0;
    let syncError = '';
    try {
      synced = await syncGoodsSnapshot(openid, check.data, now);
    } catch (err) {
      console.error('syncGoodsSnapshot error:', err);
      syncError = (err && err.message) || String(err);
    }

    return {
      code: 0,
      message: '保存成功',
      v: CODE_VERSION,
      user: Object.assign({}, existing, check.data, { updatedAt: now }),
      synced,
      syncError
    };
  }

  // 档案不存在（比如用户数据被清理过）：补建一条
  // 注意：云函数 add 不会自动写 _openid，必须手动带上，
  // 否则下次 findUser 依然查不到，会反复新建
  const profile = Object.assign(
    { _openid: openid, createdAt: now, updatedAt: now },
    check.data
  );
  const addRes = await db.collection(USERS).add({ data: profile });

  return {
    code: 0,
    message: '保存成功',
    user: Object.assign({ _id: addRes._id }, profile)
  };
}

// ============================================================
// 学号唯一性
// ============================================================
//
// 【为什么不能只「查一下有没有人用过」就完事】
//
//   用户 A 注册 202409050125 → 查：没人用过 → 写入 ✓
//   用户 B 同时注册同一个号 → 查：没人用过 → 写入 ✓   ← 两个人同一个学号
//
// 两次查询之间有个窗口。网络越慢窗口越大，校园网卡的时候
// 两个人同时点的概率并不低。这叫竞态，靠「写得更小心」是解决不掉的。
//
// 【解法：把学号当主键】
//
// 把学号写进 student_ids 集合当 _id。_id 是主键，
// 重复插入【必然失败】—— 这是数据库层面的原子操作，不存在窗口。
//
// 代码只能降低冲突的概率，数据库约束才能消灭它。
// 这个区别值得记住：凡是「先查再写」的判断，都是错的。

// 占用一个学号。返回 { ok: true } 或 { ok: false, message }
async function claimStudentId(openid, studentId) {
  // 第一步：查 users 表。
  //
  // 这一步是为了兜【历史数据】—— 在这个功能上线之前注册的用户，
  // 占位表里没有他们的记录，光靠占位表拦不住别人冒用他们的学号。
  const dup = await db
    .collection(USERS)
    .where({ studentId })
    .limit(1)
    .get()
    .catch(() => null);

  const takenBy = dup && dup.data && dup.data[0];
  // 排除自己：已经注册过的人再走一次（比如改了昵称重填），
  // 不该被自己那条档案拦住
  if (takenBy && takenBy._openid !== openid) {
    return { ok: false, message: '该学号已被其他同学注册' };
  }

  // 第二步：占位。这一步是为了兜【并发】。
  try {
    await db.collection(STUDENT_IDS).add({
      data: { _id: studentId, openid, createTime: new Date() }
    });
  } catch (err) {
    // 占位失败。此时【必须分清】是「真被别人占了」还是「别的问题」——
    // 分不清的话，一次网络抖动会伪装成「学号已被注册」，
    // 用户换个学号再试，问题照样在，而他已经不知道该怀疑什么了。
    const doc = await db
      .collection(STUDENT_IDS)
      .doc(studentId)
      .get()
      .catch(() => null);

    // 判断依据是【文档在不在】，不是 owner 等不等于我。
    // 两者看着差不多，差在一个边界上：手工往控制台插的测试数据没有 openid，
    // 用 owner 判断会滑进 else，报成「服务异常」，让人以为代码有 bug。
    const exists = !!(doc && doc.data);

    if (exists && doc.data.openid === openid) {
      // 占用者就是自己：上一次注册走到一半失败了，这次是重试。
      // 不放行的话，用户会看到「该学号已被注册」，而占用者是他自己 —— 死锁。
    } else if (exists) {
      return { ok: false, message: '该学号已被其他同学注册' };
    } else {
      // 占位表里根本没有这条 → 不是重复冲突，是别的原因（网络、没建集合）。
      // 报「学号被占用」会把人引到完全错误的方向 —— 他会去查数据，
      // 而真正的问题是「student_ids 这个集合还没建」。
      console.error('占用学号失败（非重复冲突）：', err);
      return { ok: false, message: '注册失败，请稍后重试' };
    }
  }

  return { ok: true };
}

// 释放用户上一次占用的学号（换学号时才需要）
//
// 【调用时机很重要：必须在用户档案写成功之后。】
// 反过来先释放旧的、再去写档案，一旦写档案失败，
// 用户档案里还是旧学号、占位却已经没了 —— 那个号变成谁都能抢的空号。
async function releaseStudentId(existing, newStudentId, openid) {
  const old = existing && existing.studentId;
  if (!old || old === newStudentId) return;

  // 只删自己占的那一条。万一占位表里这条的 owner 不是自己
  // （历史数据从来没占过位、或者被别的流程写过），就【不动它】——
  // 删错一条，等于凭空放出一个别人的学号。
  const doc = await db
    .collection(STUDENT_IDS)
    .doc(old)
    .get()
    .catch(() => null);

  const owner = doc && doc.data && doc.data.openid;
  if (owner !== openid) return;

  await db
    .collection(STUDENT_IDS)
    .doc(old)
    .remove()
    .catch((err) => console.warn('释放旧学号失败（不影响本次注册）：', err));
}

// 【V-03 修复】注册频率限制：同一 openid 在 60 秒内最多提交 3 次注册请求。
//
// 【为什么用 openid 而不是 IP】
//   云函数里能稳定拿到的是 openid（cloud.getWXContext），IP 需要额外
//   解析且可能被代理掩盖、也可能是全校共用的出口 IP（一限就把同学全限了）。
//   这里要挡的是「同一个人反复试探坐标 / 半径阈值」这种行为 ——
//   它必然发生在同一个 openid 下；真实学生偶发重试不会超过 3 次，
//   超过就说明不是手点的。
//
// 【为什么放在注册流程最前面】
//   定位核验与学号占位都要读写数据库。限流必须先于它们生效，
//   否则这道门只是「记录了攻击频率」，没有「拦住」。
//
// ⚠️ 局限：这是云函数【实例内存】级别的计数，实例被回收或多实例并发时
//    拦不住全部。要严格限流需要落在数据库/Redis 上。此处按「提高成本」
//    的目标选轻量方案，如需强限流请一并改造 —— 这一点已写入修复报告的遗留事项。
const REGISTER_WINDOW_MS = 60 * 1000;
const REGISTER_MAX_PER_WINDOW = 3;
const registerHits = new Map();
function registerRateLimited(openid) {
  const now = Date.now();
  const hits = (registerHits.get(openid) || []).filter(
    (t) => now - t < REGISTER_WINDOW_MS
  );
  if (hits.length >= REGISTER_MAX_PER_WINDOW) {
    registerHits.set(openid, hits);
    return true;
  }
  hits.push(now);
  registerHits.set(openid, hits);
  return false;
}

// 定位预览限流：点「获取位置」比点「完成注册」勤，单独放宽一点。
const PREVIEW_WINDOW_MS = 60 * 1000;
const PREVIEW_MAX_PER_WINDOW = 8;
const previewHits = new Map();
function previewRateLimited(openid) {
  const now = Date.now();
  const hits = (previewHits.get(openid) || []).filter(
    (t) => now - t < PREVIEW_WINDOW_MS
  );
  if (hits.length >= PREVIEW_MAX_PER_WINDOW) {
    previewHits.set(openid, hits);
    return true;
  }
  hits.push(now);
  previewHits.set(openid, hits);
  return false;
}

// 注册页「距学校约几公里」的提示。只返回距离和是否在范围内，
// 【不返回学校坐标】—— 前端包里不再带那一对数字。
async function previewLocation(openid, event) {
  if (previewRateLimited(openid)) {
    return { code: -1, message: '操作过于频繁，请稍后再试', v: CODE_VERSION };
  }

  const lat = Number(event.latitude);
  const lng = Number(event.longitude);
  const ev = evaluateCampusLocation(lat, lng);

  console.log(
    '[定位预览] v' + CODE_VERSION +
    ' 收到=' + lat + ',' + lng +
    ' 距离=' + (ev.distance != null ? Math.round(ev.distance) : 'n/a') +
    'm 通过=' + !!ev.ok +
    (ev.spoofPin ? ' spoofPin' : '')
  );

  if (ev.spoofPin || (ev.distance == null && !ev.ok)) {
    return {
      code: 0,
      inRange: false,
      distanceM: null,
      message: ev.message,
      v: CODE_VERSION
    };
  }

  return {
    code: 0,
    inRange: !!ev.ok,
    distanceM: Math.round(ev.distance),
    v: CODE_VERSION
  };
}

// 注册：核验学生身份，然后写入档案
//
// 和 updateProfile 的三点区别：
//   1. 学号【必填】—— 这是「注册」和「随手改个资料」最大的不同；
//   2. 要过定位核验，且学号要过唯一性；
//   3. 成功后打上 verified: true，这个字段就是全站的通行证。
async function registerStudent(openid, event) {
  // 【V-03 修复】先限流，再做任何读写。
  if (registerRateLimited(openid)) {
    return { code: -1, message: '操作过于频繁，请稍后再试' };
  }

  const existing = await findUser(openid);

  const check = validateProfile(event);
  if (!check.ok) return { code: -1, message: check.message };

  // 学号必填。validateProfile 里之所以只写「填了才校验格式」，
  // 是因为那一份是给【编辑资料】用的 —— 老用户改个昵称不该被学号拦住。
  // 注册这道门是另一回事：不填不许过。
  if (!check.data.studentId) {
    return { code: -1, message: '请填写学号' };
  }

  // 真实姓名必填。理由同学号：validateProfile 里那份是给「编辑资料」用的，
  // 所以写的是「填了才校验」；注册是另一回事，不填不许过。
  if (!check.data.realName) {
    return { code: -1, message: '请填写真实姓名' };
  }

  // 已核验账号仍要走定位（强制重新注册 / 再核验位置）。
  // 学号和真名锁死：用档案里的值覆盖请求，不因填错或调试乱填而在定位前被拒。
  // 未核验空档案不受影响。
  if (existing && existing.verified === true) {
    if (existing.studentId) check.data.studentId = String(existing.studentId);
    if (existing.realName) check.data.realName = String(existing.realName);
  }

  // ---- 定位核验 ----
  // 真机仍走 wx.getFuzzyLocation，半径仍是 ALLOW_RADIUS_M。
  // 和 previewLocation 共用 evaluateCampusLocation，多出来的只是
  // 「贴得比 MIN_DISTANCE_M 还近」当成数据异常，不改正常学生的半径。
  let distance = null;

  if (DEV_SKIP_LOCATION) {
    console.log('[注册] ⚠️ DEV_SKIP_LOCATION 开着，本次【跳过】定位核验');
  } else {
    const lat = Number(event.latitude);
    const lng = Number(event.longitude);
    const ev = evaluateCampusLocation(lat, lng);

    console.log(
      '[注册] 定位明细 v' + CODE_VERSION +
      ' 收到=' + lat + ',' + lng +
      ' 学校=' + SCHOOL_LAT + ',' + SCHOOL_LNG +
      ' 距离=' + (ev.distance != null ? Math.round(ev.distance) : 'n/a') +
      'm 允许=' + ALLOW_RADIUS_M + 'm 下限=' + MIN_DISTANCE_M + 'm' +
      (ev.spoofPin ? ' spoofPin' : '')
    );

    if (!ev.ok) {
      return { code: -1, message: ev.message };
    }
    distance = ev.distance;
  }

  const now = new Date();

  // ---- 学号唯一性 ----
  // 放在写档案【之前】：占不上号就什么都别写，档案保持原样。
  // 放在后面的话，会出现「学号已被别人注册，但我的档案已经改好了」这种半成品。
  const claimed = await claimStudentId(openid, check.data.studentId);
  if (!claimed.ok) {
    return { code: -1, message: claimed.message };
  }

  // 注册页收的是 昵称 / 真实姓名 / 学号 / 宿舍 四项，而 validateProfile
  // 会把【没传】的头像、手机号、微信号一律当成空字符串返回。
  // 直接拿它去 update，就会把老用户已经填好的头像和联系方式抹掉 ——
  // 并且注册是【必经】的，等于每个人都必然被清一次，
  // 而且现象是「我的头像怎么没了」，没人会联想到是注册干的。
  // 所以注册页不收的那几个字段，从这里的老档案捡回来。
  //
  // ⚠️ realName【不在这里捡】：注册页收了它，check.data 里带着，
  //    捡的话反而会把新填的真名盖成老值。
  const keepFromExisting = existing
    ? {
        avatar: existing.avatar || '',
        phone: existing.phone || '',
        wechat: existing.wechat || ''
      }
    : {};

  const profileData = Object.assign({}, check.data, keepFromExisting, {
    verified: true,
    verifiedAt: now,
    // 入学年份从学号前 4 位推出来【存一份】，界面就能直接显示「2024级」，
    // 不用每个用到的地方都自己去 slice —— 学号规则的解析只在这一个地方发生。
    enrollYear: Number(check.data.studentId.slice(0, 4)),
    updatedAt: now
  });

  if (existing) {
    await db.collection(USERS).doc(existing._id).update({ data: profileData });

    // 档案写成功了，这才轮到释放旧学号。
    // 换学号的人（原来 2023xxx，改成 2024xxx）如果不释放，
    // 旧学号会被他自己永久占着 —— 别人用不了，他也用不上。
    await releaseStudentId(existing, check.data.studentId, openid);

    // 老用户是【被强制重新注册】进来的，他多半已经有在售商品了。
    // 昵称头像要是改了，商品上的快照得跟着同步 —— 和 updateProfile 同一个道理。
    let synced = 0;
    let syncError = '';
    try {
      synced = await syncGoodsSnapshot(openid, profileData, now);
    } catch (err) {
      console.error('syncGoodsSnapshot error:', err);
      syncError = (err && err.message) || String(err);
    }

    return {
      code: 0,
      message: '注册成功',
      v: CODE_VERSION,
      user: Object.assign({}, existing, profileData),
      synced,
      syncError
    };
  }

  // 档案不存在（正常不会走到这儿，login 已经建过了；
  // 但用户数据被清理过就会）—— 补建一条，_openid 必须手动带。
  //
  // 这条分支【不需要释放旧学号】：existing 为空，说明这个人从来没有档案，
  // 也就不可能占用过别的学号。
  const profile = Object.assign({ _openid: openid, createdAt: now }, profileData);
  const addRes = await db.collection(USERS).add({ data: profile });

  return {
    code: 0,
    message: '注册成功',
    v: CODE_VERSION,
    user: Object.assign({ _id: addRes._id }, profile)
  };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const action = (event && event.action) || 'getHomeData';

  try {
    switch (action) {
      case 'getHomeData':
        return await getHomeData(OPENID);
      case 'getProfile':
        return await getProfile(OPENID);
      case 'updateProfile':
        return await updateProfile(OPENID, event);
      case 'previewLocation':
        return await previewLocation(OPENID, event);
      case 'register':
        // 【V-03 修复】"跳过定位核验"的开关在生产环境必须关闭。
        //
        // 【为什么要做成"停用接口"而不是"继续放行"】
        //   这个开关一旦误置为 true，定位核验会被整体旁路：
        //   任何人（包括校外的人）都能注册成功、拿到 verified。
        //   更糟的是它对现场是【隐形】的 —— 注册日志里那行
        //   distance=xxx 不会再打印，你会以为"最近定位都挺准"，
        //   直到有人拿着校外账号发布违规内容才发现。
        //   配错的开关应当把【功能】关掉，而不是把【安全】关掉：
        //   宁可注册暂时不可用（用户会立刻反馈），
        //   也不要悄无声息地对所有人放行。
        if (DEV_SKIP_LOCATION) {
          console.error(
            '[user] DEV_SKIP_LOCATION=true，注册接口已按安全策略停用。' +
            '请在云函数配置中移除该开关后重新部署。'
          );
          return { code: -1, message: '注册服务暂时不可用，请联系管理员' };
        }
        return await registerStudent(OPENID, event);
      default:
        // 版本号必须出现在【失败】路径上，不能只出现在成功路径里。
        // 原来只有 updateProfile 成功时返回 v，可是部署没生效时
        // 你恰恰是失败的那一边 —— 看不到版本号，就失去了唯一的探针。
        return {
          code: -1,
          message: '未知操作：' + action + '（云端版本 v' + CODE_VERSION + '）'
        };
    }
  } catch (err) {
    console.error('user error:', action, err);
    return { code: -1, message: '操作失败：' + err.message };
  }
};
