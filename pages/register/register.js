// pages/register/register.js
//
// 注册页：全站的闸门。
//
// 为什么需要它：在这之前，login 云函数在用户【第一次打开小程序时】
// 就默默把档案建好了 —— 「有没有档案」根本区分不出「有没有注册」。
// 所以档案上加了 verified 字段：只有走完这一页才会变成 true。
//
// 【谁把用户送到这一页的】
//   不是启动时的强制跳转了（那个已经去掉，见 app.js 里 onLaunch 的说明）。
//   现在是四个入口主动带过来：发布页的空状态、我的页的提示条、
//   下单/聊天时的弹框、编辑资料的「去完成核验」。
//   所以这一页是【可以退出的】—— 原生导航栏有返回箭头，用户随时能回去逛。
//
// 注册成功后要打三个标记：
//   verified / verifiedAt   —— 通行证
//   enrollYear              —— 从学号前 4 位推出来的入学年份，界面可以直接显示「2024级」
const {
  requestLocation,
  openLocationSetting
} = require('../../utils/location');
const {
  NICKNAME_MAX,
  REAL_NAME_MAX,
  BRAND
} = require('../../utils/cloud-config');
const { CAMPUS_OPTIONS } = require('../../utils/campus');

Page({
  data: {
    // 学校名。页顶那句「仅面向 XX 在校学生开放」用它。
    // 不写死在 wxml 里：买家换学校只改 BRAND 一处。
    // ⚠️ 但真正决定「在不在校内」的是云函数里的坐标，
    //    换学校时 cloudfunctions/user/index.js 的 SCHOOL_LAT/SCHOOL_LNG
    //    必须一起改，否则页面上写着 A 校、实际按 B 校核验。
    brand: BRAND,
    nickname: '',
    // 真实姓名。只有管理员和用户本人能看到 —— 商品页、聊天、订单里
    // 走的一律是 nickname。服务端那三处「快照」都只挑 nickname/avatar，
    // 见 cloudfunctions/user/index.js 里 syncGoodsSnapshot 的警告注释。
    realName: '',
    studentId: '',
    campus: '',
    showCampusPicker: false,
    // 宿舍（园区）选项。四个名字的唯一来源是 utils/campus.js，
    // 不在这里再写一遍 —— 换学校时只改那一处。
    campusOptions: CAMPUS_OPTIONS,

    // 定位结果。latitude/longitude 拿到后暂存在这里，
    // 等用户点「完成注册」时和表单一起提交 —— 不单独发一次请求。
    latitude: null,
    longitude: null,
    locating: false,
    // idle 还没取 / ok 已取到 / fail 失败了
    locStatus: 'idle',
    locText: '尚未获取位置',

    submitting: false
  },

  // 【2026-10-14 删掉了 onLoad】
  //
  // 它原来只做一件事：按当前年份生成那句「学号前 4 位是入学年份
  // （2022-至今）」的提示。提示被产品要求去掉之后，这个 onLoad
  // 就空了，于是整个删掉 —— 留一个空壳会让人以为「这里以后还要放东西」。
  //
  // ⚠️ 但那条【规则】还在云函数里（STUDENT_ID_MIN_YEAR，见
  //    cloudfunctions/user/index.js 第 330 行附近的校验）。
  //    现在填错年份会在【提交时】才被拒，报错弹窗里才告诉用户范围。
  //    想让 2022 级之前的老生也能注册，改的是云函数那个常量，
  //    改这里没有任何用。

  onNicknameChange(e) {
    this.setData({ nickname: e.detail });
  },

  onRealNameChange(e) {
    this.setData({ realName: e.detail });
  },

  onStudentIdChange(e) {
    this.setData({ studentId: e.detail });
  },

  onSelectCampus() {
    this.setData({ showCampusPicker: true });
  },

  onConfirmCampus(e) {
    // Vant 1.10+ 的 confirm 事件里 e.detail.value 是选中项【对象】{ text, value }
    const picked = e.detail.value || {};
    this.setData({ campus: picked.value || '', showCampusPicker: false });
  },

  onCloseCampusPicker() {
    this.setData({ showCampusPicker: false });
  },

  // 获取位置。
  //
  // 【必须由用户点击触发】，不能在 onLoad 里自动调：
  // 一是「一进来就弹授权窗」很骚扰，二是审核员要看的就是
  // 「用户在哪里主动使用了位置能力」—— 这一页要截的正是这个按钮。
  onGetLocation() {
    if (this.data.locating) return;

    this.setData({ locating: true, locStatus: 'idle', locText: '正在获取位置...' });

    requestLocation().then((res) => {
      if (res.ok) {
        // 距离问云函数，不在前端包里算。
        //
        // 学校坐标如果写在 utils/cloud-config.js，反编译就能拿到
        // 「填哪一对数字能过核验」—— 所以坐标留在 user 云函数，
        // 这里只把真机定位结果送上去问。
        //
        // ⚠️ 这里【只提示、不拦截】。预览失败也把坐标留下，用户仍可提交，
        //    由 register 裁决 —— 和原来「前端不管死」是同一条。
        this.setData({
          latitude: res.latitude,
          longitude: res.longitude
        });

        wx.cloud
          .callFunction({
            name: 'user',
            data: {
              action: 'previewLocation',
              latitude: res.latitude,
              longitude: res.longitude
            }
          })
          .then((r) => {
            const result = (r && r.result) || {};
            const meters = Number(result.distanceM);
            const hasMeters = Number.isFinite(meters);
            const km = hasMeters ? (meters / 1000).toFixed(1) : '';
            const inRange = result.code === 0 && result.inRange === true;

            // 【2026-10-15：在范围内不再显示公里数】
            //
            // 原来在范围内显示的是「已获取位置 · 距学校约 3.6 公里」。
            // 那个数字看着informative，实际是纯噪音，而且【会反过来制造问题】：
            //   getFuzzyLocation 不调 GPS，用的是基站 + WiFi 网络定位，
            //   误差本来就是公里级。所以一个真正站在校园里的人，
            //   看到「距学校约 3.6 公里」只会得出一个结论 ——
            //   「定位坏了」。而系统其实完全正常。
            //   （这正是 2026-10-14 实际发生的一次误判，当时去查了坐标系和半径。）
            //
            // 定稿文案（2026-10-15 产品定的）：
            //   在范围内   → 「已获取位置，在学校范围内」
            //   不在范围内 → 「无法获取位置，核验失败」
            // 两条都不再显示公里数。
            //
            // ⚠️ 一处措辞上的不准确，记在这里免得以后当成 bug 查：
            //   「不在范围内」这一支说的「无法获取位置」其实【位置是取到了】，
            //   取到的那对坐标离学校太远而已。之所以不照实说「你不在学校」，
            //   是产品选择 —— 对用户来说「没通过」比「你离得太远」更好接受，
            //   也避免了「你说我不在学校，可我明明在」这种争论。
            //   代价是：真遇到定位失败的人可能会去翻手机的位置权限。
            //   反正【能不能注册仍然由云函数裁决】，前端这句只是提示，
            //   说得含糊一点不影响正确性。
            //
            //   注意这和「前端只管显示、云函数才是裁决者」不冲突：
            //   这里改的是【显示】。前端既不拦也不放行。
            this.setData({
              locating: false,
              locStatus: inRange ? 'ok' : 'fail',
              locText: inRange
                ? '已获取位置，在学校范围内'
                : hasMeters
                  ? '无法获取位置，核验失败'
                  : (result.message || '已获取位置，提交后由服务器核验')
            });
          })
          .catch((err) => {
            console.warn('定位预览失败：', err);
            this.setData({
              locating: false,
              locStatus: 'ok',
              locText: '已获取位置，提交后由服务器核验'
            });
          });
        return;
      }

      // 用户拒绝过授权。这里不能只说「你拒绝了」——
      // 他不知道去哪儿改，只会反复点这个按钮。
      if (res.needSetting) {
        this.setData({
          locating: false,
          locStatus: 'fail',
          locText: '需要位置权限才能完成注册'
        });
        wx.showModal({
          title: '需要位置权限',
          content: '注册需要确认你在学校范围内。请点「去设置」，把「位置信息」打开。',
          confirmText: '去设置',
          cancelText: '暂不',
          success: (m) => {
            if (!m.confirm) return;
            openLocationSetting().then((granted) => {
              // 用户从设置页回来且确实开了，就自动再取一次，
              // 省得他再找一次按钮
              if (granted) this.onGetLocation();
            });
          }
        });
        return;
      }

      this.setData({
        locating: false,
        locStatus: 'fail',
        locText: res.message || '获取位置失败'
      });
    });
  },

  // 完成注册
  onSubmit() {
    if (this.data.submitting) return;

    const nickname = (this.data.nickname || '').trim();
    const realName = (this.data.realName || '').trim();
    const studentId = (this.data.studentId || '').trim();

    if (!nickname) {
      wx.showToast({ title: '请输入昵称', icon: 'none' });
      return;
    }
    if (nickname.length > NICKNAME_MAX) {
      wx.showToast({ title: '昵称不能超过' + NICKNAME_MAX + '个字', icon: 'none' });
      return;
    }

    // 真实姓名：前端查「非空 + 长度」，两条都是纯格式。
    // 「必须填真名」这条【规则】本身归云函数管（registerStudent 里
    // 有一道同样的必填判断）—— 前端这层只为让用户少等一次网络往返，
    // 理由和下面学号那段完全一样。
    if (!realName) {
      wx.showToast({ title: '请输入真实姓名', icon: 'none' });
      return;
    }
    if (realName.length > REAL_NAME_MAX) {
      wx.showToast({ title: '姓名不能超过' + REAL_NAME_MAX + '个字', icon: 'none' });
      return;
    }

    // 前端只查【位数】这一条，入学年份的范围【故意不在这里查】。
    //
    // 理由：年份范围是业务规则，它的裁决者是云函数。前端再写一遍，
    // 就变成了同一条规则存两份 —— 哪天上限改了（比如放开到 2020 级），
    // 只改了云函数、忘了这里，就会出现「前端说不行、后端说行」
    // 这种最难查的不一致。位数是纯格式，两边一致不会分叉，才放在这儿。
    if (!/^\d{12}$/.test(studentId)) {
      wx.showToast({ title: '学号必须是 12 位数字', icon: 'none' });
      return;
    }

    // 【这里故意不拦「没拿到定位」】
    //
    // 一开始我在这儿写了 if (locStatus !== 'ok') return —— 看着很合理，
    // 其实是个雷：云函数上那个 DEV_SKIP_LOCATION 是【服务端】的开关
    // （2026-10-03 已关掉，定位核验现在是生效的），前端一拦，
    // 请求根本发不出去，开关永远没机会生效，
    // 人就【锁死在注册页】—— 恰恰是那个开关存在要防的事。
    //
    // 开关关掉之后这一条依然成立，而且理由更硬了：
    // 「没定位能不能注册」本来就是【规则】，规则归云函数管。
    // 前端在这儿再判一次，就成了同一条规则存两份，
    // 哪天上限松紧变了只改一边，就会出现「前端说不行、后端说行」。
    //
    // 所以前端只做两件事：尽力去取、如实显示状态（见 onGetLocation）。
    // 拿没拿到都照原样提交，由云函数裁决 —— 它的报错信息足够清楚。

    this.setData({ submitting: true });
    wx.showLoading({ title: '提交中...' });

    wx.cloud
      .callFunction({
        name: 'user',
        data: {
          action: 'register',
          nickname,
          realName,
          studentId,
          campus: this.data.campus || '',
          latitude: this.data.latitude,
          longitude: this.data.longitude
        }
      })
      .then((res) => {
        wx.hideLoading();
        this.setData({ submitting: false });
        const result = (res && res.result) || {};

        if (result.code !== 0) {
          wx.showModal({
            title: '注册未通过',
            content: result.message || '请检查填写的信息',
            showCancel: false
          });
          return;
        }

        // 档案更新到全局，省得别的页面再拉一次
        const app = getApp();
        if (app && app.globalData) {
          app.globalData.userInfo = result.user || null;
        }

        wx.showToast({ title: '注册成功', icon: 'success' });
        // 首页是 tabBar 页，用 switchTab 回；reLaunch 也行但会重建整个页面栈
        setTimeout(() => {
          wx.switchTab({ url: '/pages/home/home' });
        }, 800);
      })
      .catch((err) => {
        wx.hideLoading();
        this.setData({ submitting: false });
        console.error('注册失败：', err);
        wx.showModal({
          title: '提示',
          content: '网络异常或云函数调用失败，请确认已部署 user 云函数（v7 及以上）后重试',
          showCancel: false
        });
      });
  },

  onReady() {},
  onShow() {
    const app = getApp();
    const user = (app && app.globalData && app.globalData.userInfo) || null;
    if (!user) return;
    const patch = {};
    if (!this.data.nickname && user.nickname && user.nickname !== '校园用户') {
      patch.nickname = user.nickname;
    }
    if (!this.data.realName && user.realName) patch.realName = user.realName;
    if (!this.data.studentId && user.studentId) {
      patch.studentId = String(user.studentId);
    }
    if (!this.data.campus && user.campus) patch.campus = user.campus;
    if (Object.keys(patch).length) this.setData(patch);
  },
  onHide() {},
  onUnload() {},
  onPullDownRefresh() {},
  onReachBottom() {},
  onShareAppMessage() {}
});
