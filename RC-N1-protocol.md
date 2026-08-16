# DJI RC-N1 电脑读取协议参考（实测确认）

> 实测环境：Windows 10 + RC-N1，USB 直连。数据源：`rc-n1-read.ps1` 实时读取验证通过。
> 参考库：IvanYaky / thanhmobiledev `DJI_RC-N1_SIMULATOR_FLY_DCL`（已 clone 到 `ref-thanh/`、`ref-ivanyaky/`）。

## 1. 设备识别

- USB 厂商/产品 ID：`VID_2CA3 & PID_1020`，复合设备（MI_00 ~ MI_04）。
- 数据通道 = **COM4**（`USB 串行设备`，接口 MI_02）。COM3（MI_04）为空。
- `MA Channel`(MI_00)、`HS-Data Channel`(MI_01) 是 DJI 专有接口，Windows 无驱动（Error），**无需处理**。
- 波特率：115200（VCOM 虚拟串口，实际忽略波特率，USB bulk 直传）。

## 2. 协议：D-UML

**必须主动请求**，RC-N1 不会主动推摇杆数据。流程：

1. 发送「启用模拟器模式」：`send_duml(src=0x0A, tgt=0x06, type=0x40, set=0x06, id=0x24, payload=[0x01])`
2. 循环发送「读通道」：`send_duml(src=0x0A, tgt=0x06, type=0x40, set=0x06, id=0x01, payload=[])`
3. 每包返回 38 字节应答（cmd_id 0x01）。

### 帧格式（发 & 收同构）

```
[0] 0x55            帧头
[1] length & 0xFF   长度低字节
[2] (length>>8)|0x04 长度高位|协议版本
[3] header CRC      头校验（seed 0x77，表 arr_2A103）
[4] source
[5] target
[6..7] sequence     小端（固定 0x34EB）
[8] cmd_type        请求 0x40；应答 0x80（最高位置位）
[9] cmd_set         0x06
[10] cmd_id         0x01=读通道应答
[11..n-3] payload
[n-2..n-1] CRC16    小端（seed 0x3692，表 crc）
```

长度字段 = 低 10 位（`ph & 0x3FF`）。总包长 = 13 + payload 长度。

### 已知命令字节

- 读通道（13 字节）：`55 0D 04 33 0A 06 EB 34 40 06 01 74 24`
- 启用模拟器模式（14 字节）：`55 0E 04 ?? 0A 06 EB 34 40 06 24 01 ?? ??`（头 CRC 与 CRC16 由脚本现算）

## 3. 38 字节应答（cmd_id 0x01）解析

数据字段（绝对字节偏移，0 起，小端 16 位）：

| 偏移 | 字段 | 语义（Mode 2） |
|---|---|---|
| 13:15 | RH | 右杆横（roll 横滚） |
| 16:18 | RV | 右杆竖（pitch 俯仰） |
| 19:21 | LV | 左杆竖（throttle 油门） |
| 22:24 | LH | 左杆横（yaw 航向） |
| 25:27 | DIAL | 拨轮（云台/变焦） |
| 28 | FN | 按键（bit0 = Fn 键） |

**中心值 = 1024**，量程约 364 ~ 1684（±660）。归一化：`(raw - 1024) / 660`。

## 4. 待确认（摇摆测试）

- 各轴「正负方向」与物理方向的对应（如 LV 增大是上升还是下降）。
- 拨轮是左拨轮（云台）还是右拨轮（变焦），以及是否还有第二个拨轮通道。
- 按键 bit 位与各物理按键（RTH / 录制 / 快门 / 暂停 / Fn）的对应。

## 5. 文件

- `rc-n1-read.ps1` — 实时读取器（零依赖，PowerShell），已通过自测 + 实测。
- `rc-n1-diag.ps1` — 诊断：切包打印各包长度/类型/完整 38 字节应答。
- `rc-n1-poll-test.ps1` — 最小轮询测试。
- `rc-n1-capture.ps1` — 原始字节流抓取（`.bin` / `.hex`）。
- `rc-n1-probe.ps1` — USB 枚举探测。

## 6. 移植到 Node 的要点

- 主进程用 `serialport` 打开 COM4（115200）。
- 移植 `Calc-Checksum`（seed 0x3692）与 `Calc-HdrChecksum`（seed 0x77）两个表。
- 帧解析注意：`pl = (len_lo | len_hi<<8) & 0x3FF`；按帧头 0x55 + 长度切包，**只挑 len==38 且 cmd_id==0x01 的包**（忽略 21 字节 cmd 0x26 / 14 字节心跳 / 19 字节包）。
- `Read-U16` 记得先转 int 再移位（PowerShell 的坑在 JS 里不存在，但注意 `data[i] << 8 | data[i+1]` 小端）。
