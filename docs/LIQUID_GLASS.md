# 液态玻璃交互

## 参考项目

- [liquid-glass-web-react](https://github.com/PallavAg/liquid-glass-web-react)：React 与 SVG 位移图，参考其边缘折射、表面高光和尺寸变化时更新位移图的思路。
- [cocolayuan/liquid-glass](https://github.com/cocolayuan/liquid-glass)：参考圆角矩形距离场生成边缘位移图、玻璃选中层平滑移动的设计。

本项目独立实现所需交互，没有复制网页 DOM、引入以上库或对整张无限画布做离屏截图。

## 当前实现

- `src/liquid-glass.tsx` 只处理一个鼠标所在的玻璃表面。圆角矩形距离场生成 RG 位移图，中心保持平整，折射集中于边缘；位移图按表面尺寸缓存，最多 12 张。
- 支持 SVG `backdrop-filter` 的浏览器可显示背景折射；其他浏览器保留透明模糊与边缘高光。网页效果不等同于 iOS 原生材质，已在本机 Microsoft Edge 验证。
- 鼠标高光使用 RAF 平滑跟随。侧栏共享选中背景滑动，导航链接的命中区域固定。点击波纹通过 portal 绘制，最多同时保留 4 个。
- 不改变已有 `fixed`、`sticky` 或 `absolute` 定位，不对正文施加位移滤镜。减少动态效果模式关闭跟随、波纹与悬停位移。

## 验证

`tests/e2e/glass.spec.ts` 检查悬停前后实际像素变化、弹窗位置不变、点击波纹、动态偏好切换，以及 375px、390px 表单无横向溢出。`tests/e2e/channels.spec.ts` 检查侧栏命中区域稳定。
