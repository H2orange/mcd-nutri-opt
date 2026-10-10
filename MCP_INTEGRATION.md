# MCP 接入说明

本项目基于**麦当劳中国 MCP Server**（`https://mcp.mcd.cn`）开发。本文说明实际使用的 Tool、调用流程与业务价值。

## 接入方式

| 项 | 值 |
|---|---|
| 端点 | `https://mcp.mcd.cn` |
| 传输协议 | Streamable HTTP |
| 鉴权 | 请求头 `Authorization: Bearer <MCP_TOKEN>` |
| 限流 | 每个 Token 每分钟 600 次请求，超限返回 `429` |
| 服务标识 | `mcd-mcp` v1.0.0 |
| Token 申请 | https://open.mcd.cn/mcp （手机号验证登录后申请） |

配置示例见 `mcp-config.example.json`。本项目通过 `src/mcp-client.mjs` 直连 MCP Server，
不依赖任何第三方 SDK，核心握手逻辑如下：

```
initialize → 读取Mcp-Session-Id 响应头 → notifications/initialized（返回 202空体）
→ 后续请求均携带 Mcp-Session-Id
```

> 踩坑记录：`notifications/initialized` 返回 202 空 body，直接 `JSON.parse` 会抛
> "Unexpected end of JSON input"，必须先判空。

## 实际使用的 Tool

### 1. `list-nutrition-foods` —— 营养数据基座

**业务价值**：这是本项目最核心的数据源。返回 158 条麦当劳常见餐品的
`energyKcal / protein / fat / carbohydrate / sodium / calcium`，是"热量+蛋白双约束"求解的基础。

该 Tool 返回的是自定义文本格式而非标准 JSON：

```
[160]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:
  猪柳麦满分,null,1288,308,16,16,24,781,213
  纯悦,能量约清水1杯,0,0,0,0,0,0,0
```

**两个必须处理的坑**：

1. `nutritionDescription` 字段会被塞进商品名（如「纯悦」→ `"能量约清水1杯"`、
   「芝士安格斯厚牛堡」→ `"能量约鲈鱼1条"`），因此**不能靠 description 判空**，
   解析器改为从行尾反向锚定 8 个纯数字字段。
2. 空值是字面字符串 `"null"` 而非 JSON `null`。

响应样例（`src/nutrition.mjs` 解析后）：

| 餐品 | kcal | 蛋白 | 脂肪 | 碳水 | 钠 |
|---|---|---|---|---|---|
| 巨无霸 | 513 | 27 | 26 | 42 | 961 |
| 麦辣鸡腿汉堡 | 485 | 24 | 24 | 42 | 1208 |
| 板烧鸡腿堡 | 391 | 23 | 17 | 35 | 1041 |
| 中薯条 | 289 | 4 | 12 | 38 | 165 |
| 无糖可口可乐中杯 | 0 | 0 | 0 | 1 | 35 |

### 2. `query-nearby-stores` —— 门店定位

**业务价值**：价格是门店级的，必须先确定门店才能取价。

关键坑：`searchType=1`（默认值）是查**用户的收藏餐厅**，新账号为空会返回
`60050收藏餐厅列表为空`。必须用 `searchType=2`（按位置搜索）并同时提供 `city` + `keyword`。

```
{ "beType": 1, "searchType": 2, "city": "南京", "keyword": "新街口" }
```

### 3. `query-meals` —— 菜单结构

**重要发现**：该 Tool **只返回 `code` 与 `tags`，不含名称和价格**。因此必须为每个商品编码
再调 `query-meal-detail` 取名称、再调 `calculate-price` 取价。

实测单店 83~122 个商品编码，即需要约 2N 次调用。这是本项目必须做**磁盘缓存**的原因
（缓存 TTL 6 小时，见 `src/mcp-client.mjs`）。

### 4. `query-meal-detail` —— 名称与套餐结构

入参字段名是 `code`（**不是** `productCode`，传错会报 `codemust not be blank`）。

该 Tool 返回的 `rounds` 字段是**套餐拆解的关键**：

```json
{
  "code": "9900005456",
  "name": "麦辣鸡腿汉堡三件套",
  "rounds": [
    { "id": 1, "name": "麦辣鸡腿汉堡", "choices": [
      { "code": "1440", "name": "麦辣鸡腿汉堡", "isDefault": 1, "quantity": 1, ... }
    ]},
    { "id": 2, "name": "选择套餐内小食", "choices": [
      { "code": "4810", "name": "中薯条", "isDefault": 1, "quantity": 1 },
      { "code": "4820", "name": "大薯条", "isDefault": 0, "diffPrice": "+ ¥1.5" }
    ]},
    { "id": 3, "name": "选择套餐内饮料", "choices": [
      { "code": "3050", "name": "可乐中杯", "isDefault": 1, "quantity": 1 }
    ]}
  ]
}
```

MCP Server 官方文档明确：`choices[].isDefault === 1` 即"当前默认选中的搭配"。
本项目据此拆解套餐，无需猜测或遍历排列组合。

### 5. `calculate-price` —— 真实到手价

价格单位是**分**。返回结构：

```json
{
  "productOriginalPrice": 2250,
  "originalPrice": 2250,
  "discount": 0,
  "price": 2250,
  "productList": [{ "productCode": "1440", "productName": "麦辣鸡腿汉堡", "quantity": 1, "subtotal": 2250 }]
}
```

**业务价值**：不信任菜单标价，用该 Tool 拿服务端返回的真实金额作为求解器的价格输入。
`discount` 是整单优惠，`src/mcp-client.mjs` 的 `allocateDiscount` 按原价比例分摊到单品
（余数给金额最大项，保证求和精确）。

## 调用流程

```
                    ┌─────────────────────────────┐
                    │1  list-nutrition-foods      │  全局营养基座（158 条，已内置仓库）
                    │   → data/nutrition.json     │
                    └──────────────┬──────────────┘
                                   │
  ┌────────────────────────────────▼───────────────────────────────┐
  │2 query-nearby-stores (searchType=2)  → 选定营业中门店 storeCode   │
  └────────────────────────────────┬───────────────────────────────┘
                                   │
  ┌────────────────────────────────▼───────────────────────────────┐
  │3 query-meals(storeCode)           → 商品编码 + 分类标签          │
  │   query-meal-detail(每编码)      → 名称 + rounds 套餐结构       │
  │   calculate-price(每编码)         → 真实到手价（分→元）          │
  │   三者结果全部写入 cache/，键含 storeCode，TTL 6h                │
  └────────────────────────────────┬───────────────────────────────┘
                                   │
  ┌────────────────────────────────▼───────────────────────────────┐
  │4 四级降级对齐 (src/matcher.mjs)   菜单 × 营养表 语义鸿沟          │
  │   L1 精确匹配      → 32~35%│
  │   L2 双向包含      →  3~ 6%  │ 名称归一化后取最长匹配
  │   L3 套餐拆解      → 30~45%   │ 按 rounds 默认搭配叠加子项营养
  │   L4 剔除非食品    →  1~ 2%   │ 酱料、周边不参与营养计算
  │   实测总命中率 79%                                             │
  └────────────────────────────────┬───────────────────────────────┘
                                   │
  ┌────────────────────────────────▼───────────────────────────────┐
  │5 约束求解 (src/solver.mjs)  纯本地计算，不调用 LLM              │
  │   品类分组 → DFS 枚举 → 槽位去重 → 约束过滤                     │
  │   → 帕累托前沿 → 取最优                                         │
  └────────────────────────────────┬───────────────────────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │6 输出方案 + 拆解明细         │
                    │   含数据可信度提示            │
                    └─────────────────────────────┘
```

## 数据可信度设计

菜单与营养表存在天然口径差异，本项目**不隐藏**这一点：

| 情形 | 处理 | 用户可见提示 |
|---|---|---|
| L1/L2 精确命中 | 直接使用 | 无 |
| L3 套餐完全解析 | 子项营养累加 | 无 |
| L3-partial 套餐 | 已解析子项累加 | ⚠ 明确提示"可能偏低" |
| 酱料/周边 | 剔除 | 不出现在候选中 |
| 完全未解析 | 不进求解 | 计入"未解析"统计 |

求解结果中标注了**策略来源**（严格品类去重/ 宽松模式），并显示
枚举组合数、可行解数、前沿解数、耗时，便于用户判断结果可信度。

## 免责声明

本项目为麦当劳程序员节创意开发大赛参赛作品，非麦当劳官方产品。
输出结果仅供参考，不构成医疗或营养建议。餐品信息、价格及供应状态
以麦当劳官方渠道实时结果为准。