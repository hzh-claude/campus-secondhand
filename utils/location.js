// utils/location.js
// 获取用户位置（模糊定位），并把「授权」这件事处理干净。
//
// ============================================================
// 为什么不能直接调 wx.getFuzzyLocation 就完事
// ============================================================
//
// 因为用户可能【已经拒绝过】授权。而一旦拒绝过一次，
// wx.authorize 就【再也不会弹窗了】—— 它直接走 fail 回调。
// 这时候唯一的路是用 wx.openSetting 把他请到设置页手动打开。
//
// 不处理这一步的后果很隐蔽：那个用户永远注册不了，
// 而界面上【一点异常都没有】—— 弹窗不出现，报错也没有，
// 他就是反复点「获取位置」，什么也不发生，然后卸载。
//
// 所以必须先 getSetting 读状态，再分三种情况处理：
//   true       已授权   → 直接拿位置
//   undefined  从没问过 → 调 authorize 弹窗
//   false      拒绝过   → 引导去 openSetting
//
// ============================================================
// 一个容易抄错的地方
// ============================================================
//
// 模糊定位的 scope 是 'scope.userFuzzyLocation'，
// 【不是】'scope.userLocation' —— 后者是精确定位 wx.getLocation 的 scope。
// 网上大量示例配置把这两个搞混，抄错的话授权弹窗根本不会出现。
// 这三个地方必须用同一个名字：
//   app.json 的 requiredPrivateInfos、app.json 的 permission 键、这里的 SCOPE。
//
// ============================================================
// 坐标系（⚠️ 这里踩过一次，2026-10-14 修）
// ============================================================
//
// wx.getFuzzyLocation 有个 type 参数，【默认值是 'wgs84'】——
// 不是 GCJ-02。不传 type，拿到的就是 GPS 原始坐标。
//
// 而学校坐标是从腾讯位置服务 / BIGEMAP 的地图上拾的，那是 GCJ-02。
// 两个坐标系在中国境内差 300~700 米（湖南永州这一带实测约 650 米）。
// 拿 WGS-84 的读数去和 GCJ-02 的点算距离，会【凭空多出 650 米】——
// 学生站在宿舍里，系统认为他在 650 米外。
//
// 所以下面调用时必须显式传 type: 'gcj02'，让两边都是 GCJ-02。
// 云函数那边拿到的一直是前端传过来的这个数，所以改这一处就够了，
// 前后端两套 distanceMeters 仍然吃同一种坐标系。
const LOCATION_TYPE = 'gcj02';

const SCOPE = 'scope.userFuzzyLocation';

// 已拒绝过授权时，引导用户去设置页打开；返回是否已打开
function openLocationSetting() {
  return new Promise((resolve) => {
    wx.openSetting({
      success: (res) => {
        const granted = (res.authSetting || {})[SCOPE] === true;
        resolve(granted);
      },
      fail: () => resolve(false)
    });
  });
}

// 确保拿到了授权（不拿位置，只管权限）
function ensureAuthorized() {
  return new Promise((resolve) => {
    wx.getSetting({
      success: (res) => {
        const state = (res.authSetting || {})[SCOPE];

        if (state === true) {
          resolve({ ok: true });
          return;
        }
        if (state === false) {
          // 拒绝过，authorize 已经不会再弹窗了，只能走设置页
          resolve({ ok: false, needSetting: true });
          return;
        }
        // undefined：从没问过，这里才是 authorize 该出场的时候
        wx.authorize({
          scope: SCOPE,
          success: () => resolve({ ok: true }),
          fail: () => resolve({ ok: false, needSetting: true })
        });
      },
      fail: () => resolve({ ok: false, message: '读取授权状态失败' })
    });
  });
}

// 当前是不是跑在开发者工具（模拟器）里
//
// 为什么非得判断这个：wx.getFuzzyLocation 【在开发者工具里必然失败】。
// 微信官方在社区的回复原话是「目前该接口不支持在工具中调试，请在真机进行调试」。
// 而它失败时返回的 errMsg 同样带 "no permission" —— 和「后台没开通接口」
// 一字不差。
//
// 于是模拟器里一跑就看到 no permission，人会立刻冲去后台查接口设置，
// 查完发现早就开通了，然后开始怀疑代码、怀疑 app.json，绕一大圈。
// 真机其实一直是好的，只是工具跑不了而已。
//
// wx.getDeviceInfo 是新的（基础库 2.20.1+，推荐用），
// 老的 wx.getSystemInfoSync 还能用但已废弃，这里做一层兼容。
function isDevtools() {
  try {
    const info = wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync();
    return info.platform === 'devtools';
  } catch (e) {
    // 拿不到就按「不是工具」处理：宁可给出后台那条提示，
    // 也不要因为一个环境判断失败就吞掉真正的排查线索
    return false;
  }
}

// 把各种失败翻译成人能看懂的话。
//
// 这一步值得单独写，因为【报错原文会把人引向错误的方向】：
// 「auth deny」看着像用户操作问题，其实可能是配置漏了；
// 「requiredPrivateInfos」看着像代码问题，其实是 app.json 少一行；
// 两行代码里的一个词之差，会决定你去查哪个地方。
function describeError(err) {
  const msg = (err && err.errMsg) || '';

  // 用户拒绝过授权
  if (msg.indexOf('auth deny') >= 0 || msg.indexOf('authDeny') >= 0) {
    return {
      text: '你拒绝了位置授权',
      dev: '用户拒绝了 scope 授权（authorize 已不再弹窗，只能走 openSetting）'
    };
  }

  // app.json 少声明。纯配置问题，用户侧无论如何都修不好
  if (msg.indexOf('requiredPrivateInfos') >= 0) {
    return {
      text: '位置服务暂不可用',
      dev: 'app.json 缺 requiredPrivateInfos: ["getFuzzyLocation"] 声明'
    };
  }

  // 后台接口权限没开通 —— 开发期最常见的一个。
  //
  // 认这个错【必须匹配 'no permission'】：
  // 报错原文是 "getFuzzyLocation:fail no permission, appId=xxx"，
  // 它既不是 'auth deny'（那是用户拒绝），也不是 'requiredPrivateInfos'
  // （那是配置漏了）。一开始漏了这一条，结果英文原文直接糊在了屏幕上。
  if (msg.indexOf('privacy') >= 0) {
    return {
      text: '请先同意隐私协议后再获取位置',
      dev: '隐私协议未同意，或后台「用户隐私保护指引」未勾选地理位置'
    };
  }

  if (msg.indexOf('no permission') >= 0) {
    // 先分清在哪跑 —— 这两种情况的报错原文完全一样，处理方式却天上地下：
    // 一个什么都不用做，一个要跑趟后台
    if (isDevtools()) {
      return {
        text: '模拟器不能获取位置，请点「预览」用手机扫码',
        dev:
          '⚠️ 你现在跑在【开发者工具】里 —— 这个接口不支持在工具中调试' +
          '（微信官方原话），模拟器里【必然】报 no permission，' +
          '跟后台有没有开通无关。别去后台查权限，请用【预览】扫码在手机上测。'
      };
    }
    return {
      text: '位置服务暂不可用，请稍后再试',
      dev:
        '⚠️ 后台未开通 wx.getFuzzyLocation。去公众平台「开发管理 → 接口设置」申请，' +
        '并在「账号设置 → 用户隐私保护指引」勾选「地理位置」'
    };
  }

  return {
    text: '获取位置失败，请重试',
    dev: '未识别的报错：' + (msg || '(空)')
  };
}

// 隐私协议弹窗。后台开了「用户隐私保护指引」之后，
// 不先走这一步，getFuzzyLocation 在真机上会直接 fail。
// 没配隐私协议时部分基础库会 fail，那种情况放行，不能因此拦住定位。
function ensurePrivacy() {
  return new Promise((resolve) => {
    if (typeof wx.requirePrivacyAuthorize !== 'function') {
      resolve({ ok: true });
      return;
    }
    wx.requirePrivacyAuthorize({
      success: () => resolve({ ok: true }),
      fail: (err) => {
        const msg = (err && err.errMsg) || '';
        console.warn('[定位] requirePrivacyAuthorize：', err);
        if (
          msg.indexOf('cancel') >= 0 ||
          msg.indexOf('disagree') >= 0 ||
          msg.indexOf('deny') >= 0
        ) {
          resolve({ ok: false, message: '需要同意隐私协议才能获取位置' });
          return;
        }
        resolve({ ok: true });
      }
    });
  });
}

// 对外只暴露这一个：隐私协议 → 授权 → 拿位置
// 返回 { ok:true, latitude, longitude }
//  或 { ok:false, needSetting:true }     ← 要引导去设置页
//  或 { ok:false, message:'...' }
function requestLocation() {
  if (isDevtools()) {
    return Promise.resolve({
      ok: false,
      message: '模拟器不能获取位置，请点「预览」用手机微信扫码后再试'
    });
  }

  return ensurePrivacy().then((privacy) => {
    if (!privacy.ok) return privacy;

    return ensureAuthorized().then((auth) => {
      if (!auth.ok) return auth;

      return new Promise((resolve) => {
        wx.getFuzzyLocation({
          // 【必须显式传】不传就是 wgs84，会和 GCJ-02 的学校坐标差 650 米。
          // 见文件开头「坐标系」那一段。
          type: LOCATION_TYPE,
          success: (res) => {
            resolve({
              ok: true,
              latitude: res.latitude,
              longitude: res.longitude
            });
          },
          fail: (err) => {
            // 屏幕上给用户看的话、和控制台给开发者看的线索，
            // 在这里分开。原始报错一定要打出来 —— describeError 认不出的错，
            // 屏幕上只会剩一句「请重试」，那时候这条日志是唯一的线索。
            const d = describeError(err);
            console.error('[定位] getFuzzyLocation 失败：', err, '\n→', d.dev);
            resolve({ ok: false, message: d.text });
          }
        });
      });
    });
  });
}

// 两个经纬度之间的球面距离（米），haversine。
//
// 【为什么前端也需要一份】
//   云函数算距离只用来【裁决】，用户看不到。而注册页原来在拿到坐标后
//   直接显示「已获取位置，可以完成注册了」—— 这句话是凭空写的：
//   前端从来没算过距离，它根本不知道用户能不能注册。
//   2026-10-09 就出了这个洋相：绿字说「可以完成注册了」，
//   点提交被云函数回一句「相距约 7 公里，无法注册」。
//   算出来摆在这儿，用户能在点提交【之前】看到真实数字。
//
// 【⚠️ 必须和 cloudfunctions/user/index.js 里的 distanceMeters 用同一套算法】
//   两边不一致的话，会出现「页面说 2.9 公里、服务端说 3.1 公里」这种
//   最让人火大的情况 —— 尤其是刚好卡在半径上的时候。
//   搜索 distanceMeters 能同时找到这两处。
//
// 【这份算出来的结果【不作数】】
//   前端的判断负责体验，服务端的判断负责安全。这里只负责提示。
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

module.exports = { requestLocation, openLocationSetting, distanceMeters };
