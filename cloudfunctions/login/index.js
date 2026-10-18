// cloudfunctions/login/index.js
// 登录云函数：换取 openid，并在 users 集合中初始化 / 更新用户档案
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const USERS = 'users';

exports.main = async () => {
  // 【V-06 修复】这里不再取 APPID / UNIONID。
  //   unionid 是「同一微信开放平台账号下跨应用的唯一标识」，
  //   本小程序没有跨应用打通需求 —— 存它只有风险没有用途：
  //   一旦 users 集合权限配错或云环境泄露，它就是一条能跨应用
  //   关联到真实身份的标识符，属于超出业务需要的数据采集。
  //   新档案从此不再产生这两个字段。
  //   （老档案里已存在的 unionid / appid 属于历史数据，处理办法
  //     见修复报告的遗留事项，本项目没有任何代码再读它们。）
  const { OPENID } = cloud.getWXContext();
  const now = new Date();

  try {
    const res = await db
      .collection(USERS)
      .where({ _openid: OPENID })
      .limit(1)
      .get();

    // 已有档案：更新活跃时间后返回
    if (res.data && res.data.length > 0) {
      const user = res.data[0];
      await db.collection(USERS).doc(user._id).update({
        data: { updatedAt: now }
      });
      return {
        code: 0,
        message: 'ok',
        openid: OPENID,
        isNew: false,
        user
      };
    }

    // 首次登录：创建档案
    // 注意：云函数 add 不会自动写入 _openid，必须手动写入，
    // 否则上面的 where({ _openid: OPENID }) 永远查不到，每次登录都会重复建档
    const profile = {
      _openid: OPENID,
      // 【V-06 修复】不再落库 appid / unionid（原因见 exports.main 顶部注释）。
      //   这两个字段是「宿主 AppID」与「跨应用唯一标识」，本业务一个都用不到：
      //   全项目的用户查询都只按 _openid（见 findUser / profileOf / getUserBrief）。
      //   少存一份能跨应用关联到个人的标识，就少一份泄露时的赔偿面。
      nickname: '校园用户',
      avatar: '',
      campus: '',
      studentId: '',
      phone: '',
      wechat: '',
      createdAt: now,
      updatedAt: now
    };
    const addRes = await db.collection(USERS).add({ data: profile });

    return {
      code: 0,
      message: 'created',
      openid: OPENID,
      isNew: true,
      // profile 中已包含 _openid，此处只需补上 _id
      user: Object.assign({ _id: addRes._id }, profile)
    };
  } catch (err) {
    console.error('login error:', err);
    return {
      code: -1,
      message: '登录失败：' + err.message,
      openid: OPENID
    };
  }
};
