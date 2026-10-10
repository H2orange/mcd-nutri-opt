# 麦当劳 MCP 数据结构实测笔记

> 实测时间：2026-10-09 17:17~17:19 | Token 已验证有效 | server: mcd-mcp v1.0.0

## 接入信息

| 项 | 值 |
|---|---|
| 端点 | `https://mcp.mcd.cn` |
| 协议 | Streamable HTTP，需 `Accept: application/json, text/event-stream` |
| 鉴权 | `Authorization: Bearer <token>` |
| 限流 | 600 次/分钟，超限返回 429 |
| 工具总数 | **35个** |

握手流程：`initialize` → 读 `Mcp-Session-Id` 响应头 → 带 session 发 `notifications/initialized`（返回 202 空体）→ 后续请求都带 `Mcp-Session-Id`。

**踩坑**：`notifications/initialized` 返回空body，直接 `JSON.parse` 会崩，必须先判空。

## 关键约束（决定架构）

### 1. 菜单是门店级的，且**不含名称和价格**

`query-meals` 只返回 `code` + `tags`，分类结构：

```json
{ "data": { "categories": [ { "name": "人气热卖", "meals": [ { "code": "1440", "tags": ["单品","人气经典"] } ] } ] } }
```

→ **必须逐个调 `query-meal-detail` 拿名称**，再逐个调 `calculate-price` 拿价格。这是本项目最大的性能成本，也是必须做缓存的原因。

### 2. 参数名不统一（高频踩坑）

| 工具 | 商品编码字段 |
|---|---|
| `query-meals` | `code`（输出侧） |
| `query-meal-detail` | **`code`**（入参侧） |
| `calculate-price` | **`productCode`** |

传错会报 `codemust not be blank`（无空格，官方错误文案如此）。

### 3. beType / orderType / beCode 传递规则

| 场景 | beType | orderType | beCode |
|---|---|---|---|
| 到店自取 | 1 | 1 | **不传**（传了报错） |
| 得来速 | 5 | 1 | 必传，来自 `query-nearby-stores` |
| 麦乐送 | 2 | 2 | 必传，来自 `delivery-query-stores` |
| 企业团餐 | 6 | 2 | 必传，来自 `delivery-query-stores` |

### 4. `query-nearby-stores` 的 searchType 陷阱

- `searchType=1`（默认）= 查**我的收藏餐厅**，新账号为空 → 报 `600050收藏餐厅列表为空`
- `searchType=2` = 按位置搜索，**必须配city + keyword**

```json
{ "beType": 1, "searchType": 2, "city": "南京", "keyword": "新街口" }
```

返回含 `storeCode` / `storeName` / `address` / `distance` / `businessStatus` / `reservationTimeOptions`。注意 `longitude`/`latitude` 返回 0，需自行补城市中心坐标做距离排序。

### 5. 营养表结构（`list-nutrition-foods`）

160 条，字段：`productName, nutritionDescription, energyKj, energyKcal, protein, fat, carbohydrate, sodium, calcium`

**两个坑**：

1. `nutritionDescription` 字段**混入了商品名**，例如：
   - `纯悦` → `"能量约清水1杯"`
   - `芝士安格斯厚牛堡` → `"能量约鲈鱼1条"`
   - 其余绝大多数为 `null`
   
   → 解析时**不能靠 description 判空**，必须按逗号位置对齐（有 description 的行字段数多一个）。

2. 数据是**全局静态**的，不含门店维度 → **可以内置进仓库做离线数据集**，这是无 Token 也能跑的基础。

典型值参考：

| 餐品 | kcal | 蛋白 | 脂肪 | 碳水 | 钠 |
|---|---|---|---|---|---|
| 巨无霸 | 513 | 27 | 26 | 42 | 961 |
| 麦辣鸡腿汉堡 | 485 | 24 | 24 | 42 | 1208 |
| 板烧鸡腿堡 | 391 | 23 | 17 | 35 | 1041 |
| 原味板烧鸡腿麦满分 | 246 | 15 | 9 | 25 | 611 |
| 中薯条 | 289 | 4 | 12 | 38 | 165 |
| 无糖可口可乐中杯 | 0 | 0 | 0 | 1 | 35 |
| 大杯鲜萃咖啡 | 13 | 1 | 0 | 0 | 3 |

### 6. 价格单位是**分**

`calculate-price` 返回 `productOriginalPrice: 2250` = 22.50 元。字段：

```json
{
  "productOriginalPrice": 2250,  // 商品原价（分）
  "productPrice": 2250,// 商品小计
  "originalPrice": 2250,         // 原价
  "discount": 0,                 // 优惠金额
  "price": 2250,                 // 应付
  "productList": [{ "productCode": "1440", "productName": "麦辣鸡腿汉堡", "quantity": 1, "originalSubtotal": 2250, "subtotal": 2250 }]
}
```

**优惠金额怎么算**：`discount` 是整单优惠，需要分摊到单品才能算单品真实成本。单人套餐场景下分摊无歧义，多商品时需按 `subtotal` 比例分摊（向下取整，余额给最大项）。

## 可用工具全表（35 个）

**营养**：`list-nutrition-foods`
**门店**：`query-nearby-stores`、`delivery-query-addresses`、`delivery-create-address`、`delivery-query-stores`、`now-time-info`
**菜单**：`query-meals`、`query-meal-detail`
**价格/下单**：`calculate-price`、`create-order`、`cancel-order`、`query-order`、`order-list`、`query-meal-assistance`、`query-promotions`
**券**：`query-my-coupons`、`available-coupons`、`auto-bind-coupons`、`query-store-coupons`
**积分**：`query-my-account`、`mall-points-products`、`mall-product-detail`、`mall-create-order`、`mall-order-list`、`mall-order-detail`、`query-lottery-info`、`draw-lottery`、`query-my-prizes`
**活动**：`campaign-calendar`、`query-party-city`、`query-party-store`、`query-party-store-date`、`query-party-store-session`、`party-order-create`
**其他**：`query-survey-coupon`

## 实测可用门店（南京，供测试固定用）

| storeCode | 名称 | 营业时间 |
|---|---|---|
| 1990346 | 麦当劳南京新百餐厅 | 07:00-22:00 |
| 1990043 | 麦当劳南京洪武餐厅 | 00:00-23:59 |
| 1990762 | 麦当劳南京青奥城市客厅餐厅 | 07:00-23:00 |
| 1990675 | 麦当劳南京新街口苏宁餐厅 | 07:00-23:00 |
| 1990100 | 麦当劳南京汉中路餐厅 | 00:00-23:59 |

推荐默认用`1990346`（已实测菜单 + 算价均通）。

## 本项目的取舍

1. **离线优先**：`list-nutrition-foods` 数据内置仓库，陌生人 clone 后 `npm run demo` 立刻能跑，无需 Token。
2. **在线增强**：有 Token 时拉真实门店菜单与到手价，用 `calculate-price` 校验。
3. **缓存必需**：菜单需 N×2 次调用（N=商品数），必须按 `storeCode` 缓存到磁盘。
4. **求解器纯本地**：枚举 +剪枝 + 帕累托前沿，不调 LLM，可单测、可复现。
