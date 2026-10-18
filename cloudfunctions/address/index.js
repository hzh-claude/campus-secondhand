// cloudfunctions/address/index.js
// 收货地址管理：列表 / 新增 / 修改 / 删除 / 设为默认
//
// 两条铁律：
//   1. 云函数里 add 不会自动写 _openid，必须手动写
//   2. 所有写操作先校验归属（_openid === 调用者），否则用户能改别人的地址
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const ADDRESS = 'address';
const MAX_ADDRESSES = 20; // 单个用户地址数量上限

// 参数校验：客户端校验不可信，服务端必须再校验一遍
function validate(input) {
  const name = String(input.name || '').trim();
  const phone = String(input.phone || '').trim();
  const campus = String(input.campus || '').trim();
  const detail = String(input.detail || '').trim();

  if (!name) return { ok: false, message: '请输入收货人姓名' };
  if (name.length > 20) return { ok: false, message: '姓名不能超过20个字' };
  if (!phone) return { ok: false, message: '请输入手机号' };
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    return { ok: false, message: '手机号格式不正确' };
  }
  if (!campus) return { ok: false, message: '请选择宿舍' };
  if (!detail) return { ok: false, message: '请输入详细地址' };
  if (detail.length > 100) {
    return { ok: false, message: '详细地址不能超过100个字' };
  }

  return { ok: true, data: { name, phone, campus, detail } };
}

// 读取地址并校验归属：不是自己的地址一律当作"不存在"
async function getOwnAddress(id, openid) {
  if (!id) return { ok: false, message: '缺少地址 ID' };

  const res = await db
    .collection(ADDRESS)
    .doc(id)
    .get()
    .catch(() => null);

  if (!res || !res.data) return { ok: false, message: '地址不存在' };
  if (res.data._openid !== openid) {
    return { ok: false, message: '地址不存在或无权限操作' };
  }
  return { ok: true, address: res.data };
}

// 清空该用户所有默认标记（把候选地址设为默认前调用）
async function clearDefault(openid, now) {
  await db
    .collection(ADDRESS)
    .where({ _openid: openid, isDefault: true })
    .update({ data: { isDefault: false, updateTime: now } });
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext(); // 身份只信服务端
  const action = event.action;
  const now = new Date();

  try {
    switch (action) {
      // ---------- 我的地址列表（默认地址排最前）----------
      case 'list': {
        const res = await db
          .collection(ADDRESS)
          .where({ _openid: OPENID })
          .orderBy('isDefault', 'desc')
          .orderBy('createTime', 'desc')
          .limit(MAX_ADDRESSES)
          .get();

        return { code: 0, message: 'ok', list: res.data || [] };
      }

      // ---------- 新增地址 ----------
      case 'add': {
        const check = validate(event);
        if (!check.ok) return { code: 1, message: check.message };

        const countRes = await db
          .collection(ADDRESS)
          .where({ _openid: OPENID })
          .count();

        if (countRes.total >= MAX_ADDRESSES) {
          return { code: 1, message: '最多只能保存 ' + MAX_ADDRESSES + ' 个地址' };
        }

        // 第一条地址自动成为默认；否则听用户的
        const isFirst = countRes.total === 0;
        const isDefault = isFirst || !!event.isDefault;

        // 业务规则：一个用户只能有一个默认地址
        if (isDefault) await clearDefault(OPENID, now);

        const addRes = await db.collection(ADDRESS).add({
          data: Object.assign(
            {
              _openid: OPENID, // ⚠️ 必须手动写
              isDefault,
              createTime: now,
              updateTime: now
            },
            check.data
          )
        });

        return { code: 0, message: '保存成功', _id: addRes._id, isDefault };
      }

      // ---------- 修改地址 ----------
      case 'update': {
        const own = await getOwnAddress(event.id, OPENID);
        if (!own.ok) return { code: 1, message: own.message };

        const check = validate(event);
        if (!check.ok) return { code: 1, message: check.message };

        await db
          .collection(ADDRESS)
          .doc(event.id)
          .update({
            data: Object.assign({ updateTime: now }, check.data)
          });

        return { code: 0, message: '保存成功' };
      }

      // ---------- 删除地址 ----------
      case 'remove': {
        const own = await getOwnAddress(event.id, OPENID);
        if (!own.ok) return { code: 1, message: own.message };

        await db.collection(ADDRESS).doc(event.id).remove();

        // 删掉的如果是默认地址，把剩下最新的一个顶上，避免出现"无默认"状态
        if (own.address.isDefault) {
          const rest = await db
            .collection(ADDRESS)
            .where({ _openid: OPENID })
            .orderBy('createTime', 'desc')
            .limit(1)
            .get();

          if (rest.data && rest.data.length > 0) {
            await db
              .collection(ADDRESS)
              .doc(rest.data[0]._id)
              .update({ data: { isDefault: true, updateTime: now } });
          }
        }

        return { code: 0, message: '删除成功' };
      }

      // ---------- 设为默认地址 ----------
      case 'setDefault': {
        const own = await getOwnAddress(event.id, OPENID);
        if (!own.ok) return { code: 1, message: own.message };

        if (own.address.isDefault) {
          return { code: 0, message: '已经是默认地址' };
        }

        await clearDefault(OPENID, now);
        await db
          .collection(ADDRESS)
          .doc(event.id)
          .update({ data: { isDefault: true, updateTime: now } });

        return { code: 0, message: '已设为默认地址' };
      }

      default:
        return { code: 1, message: '不支持的操作：' + action };
    }
  } catch (err) {
    console.error('address error:', action, err);
    return { code: -1, message: '操作失败：' + err.message };
  }
};
