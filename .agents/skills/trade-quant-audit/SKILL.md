---
name: trade-quant-audit
description: Use when auditing TradeOS live or historical trading performance, reviewing decision telemetry logs, investigating missed market moves or false signals, calibrating confluence pillars and weights, analyzing order fills and slippage against Binance, or proposing objective quantitative improvements without bias or superficial optimism.
---

# TradeOS-v2 Quant & Execution Audit (EGM Multi-Agent Protocol)

## 1. Dəqiq Rol Bölgüsü (Separation of Powers)

Bu skill-in ən təməl prinsipi **Auditor və Mühəndis rollarının tamamilə bir-birindən ayrılmasıdır**:

| Rol | Kim İcra Edir? | Səlahiyyət və Öhdəliklər | Qadağalar |
| :--- | :--- | :--- | :--- |
| **Kvant Auditoru (Adversarial Goldfish)** | **Müstəqil Subagent** (Read-Only) | Loqları, birja çıxarışlarını və bazar hərəkətlərini amansız, tərəfsiz təftiş edir; Qüsur Hesabatı (`DEFICIENCY_REPORT`) hazırlayır. | **KODA TOXUNMAQ QƏTİ QADAĞANDIR.** Fayl redaktə edə, kod yaza və ya silə bilməz. |
| **Baş Texniki Mühəndis (Elephant / Implementer)** | **Əsas Agent (Sən)** | Auditorun təqdim etdiyi qüsurları analiz edir, istifadəçi ilə razılaşdırır, dəqiq kod dəyişikliklərini icra edir, test edir və sistemi build edir. | Səthi bəhanələrlə auditorun tapdığı qüsurları ört-basdır edə bilməz. |

---

## 2. Repo və Arxitektura Kilidi (TradeOS-v2 ONLY)

Təftiş və kod işləri **YALNIZ VƏ YALNIZ TradeOS-v2** monorepo arxitekturası üzərində aparılır. Köhnə TradeOS v1 qalıqlarına toxunmaq qəti qadağandır:

* **Hədəf İş Qovluğu:** `D:\Antigravity_Projects\Active_Projects\TradeOS-v2` (və ya `C:\Users\HP\TradeOS-v2` junction linki).
* **Aktiv Monorepo Strukturu:**
  * Backend: `apps/server/src/` (TypeScript, Polka, WebSocket Hub, port `3400`).
  * Frontend: `apps/web/src/` (React, Vite, Tailwind, Zustand).
  * Paylaşılan Tiplər: `packages/shared/src/` (`@tradeos/shared`).
  * Məlumat Bazası: `data/tradeos.db` (SQLite WAL: `trades`, `decision_logs`, `pillar_telemetry`).
* **QARA SİYAHI (Köhnə v1 - Toxunmaq Qadağandır):**
  * `c:\Users\HP\TradeOS` (Köhnə v1 faylları: `server.js`, `engine.js`, `public/hud.js`, port `3300`, `.worktrees/`, və s.).

---

## 3. Müstəqil Subagent Təftiş Arxitekturası (EGM Protocol)

Skill işə salındıqda Əsas Agent **mütləq `invoke_subagent` vasitəsilə təmiz və tərəfsiz Auditor subagenti** çağırmalıdır:

```json
{
  "TypeName": "research",
  "Role": "TradeOS-v2 Adversarial Quant Auditor",
  "Prompt": "Sən TradeOS-v2 sisteminin tərəfsiz, amansız və zero-glazing prinsipli Kvant Auditorusan. Sənin hədəf kod bazan D:\\Antigravity_Projects\\Active_Projects\\TradeOS-v2-dir. Sənin işin heç bir kodu dəyişmədən yalnız oxuma rejimində son 500 şamlıq bazar hərəkətlərini, data/tradeos.db loqlarını və Binance Demo /fapi/v1/income çıxarışlarını 5 ox üzrə təftiş edib DEFICIENCY_REPORT formatında qüsurları ortaya qoymaqdır."
}
```

Niyə Subagent? Çünki subagent söhbətin əvvəlki dialoqlarından və subyektiv mühakimələrindən təcrid olunub; o, özünü müdafiə etmək məcburiyyətində deyil və bazardakı acı həqiqətləri tərəfsiz görə bilir.

---

## 4. 5 Oxlu Tərəfsiz Audit Protokolu

Auditor subagent aşağıdakı 5 ox üzrə faktiki sübutlarla yoxlama aparır:

### Ox 1: Bazarın Yerüstü Həqiqəti və Qaçırılan Fürsətlər (Ground Truth & Missed Alpha)
* **Yoxlanış:** `GET /api/klines?symbol=SOLUSDT&interval=1m&limit=500`
* Son 500 şamda baş verən əsas dalğaları (MFE/MAE) qeyd et.
* Sistem bu dalğalar zamanı nə edirdi? Niyə əmr açılmadı? Hansı sütun mane oldu?

### Ox 2: 7 Sütunun Telemetriyası və Düşüncə Loqları (Telemetry Audit)
* **Yoxlanış:** SQLite `data/tradeos.db` (`decision_logs` və `pillar_telemetry` cədvəlləri).
* 7 sütunun hər birinin verdiyi reaksiyanı yoxla:
  * P1 (Makro / ADX): Bazar hərəkət edərkən `Macro Ranging` (trendsiz) deyib əmri boğdumu?
  * P2 (Native SMC): FVG və Order Block-lar düzgün koordinatda idimi?
  * P3 (CVD Absorbsiya): Alıcı/Satıcı delta təzyiqi vaxtında aşkarlandımı?
  * P4 (L2 Order Flow): Dərinlik nisbəti düzgün qiymətləndirildimi?
  * P5 (Likvidlik Klasterləri): Ən yaxın hovuz düzgün hesabandımı?
  * P6 (Momentum / RSI): Siqnal hərəkətin başında, yoxsa ən sonunda gəldi?
  * P7 (Xəbər / Sentiment): Xəbər başlığı bazar trendinə uyğun gəldimi?

### Ox 3: Birja İcrası, Sürüşmə və Komissiya Anatomiyası (Execution & Fees)
* **Yoxlanış:** Binance Demo REST `/fapi/v1/income` və `/fapi/v1/userTrades`.
* Faktiki giriş sürüşməsini (slippage) ölç.
* Komissiya yükünü hesabla: Komissiya xalis qazancın neçə faizini apardı? (Məsələn: +$6.72 qazancın $3.87-si komissiyaya getdi — 57.5% komissiya itkisi!).

### Ox 4: Risk, Breakeven və Qazancın Qorunması (Shield Dynamics)
* **Yoxlanış:** Breakeven və Take Profit alqoritmləri.
* Pik qazanc səviyyəsi (məsələn: +$29.50) varkən nə üçün TP1 götürülmədi və ya dinamik Trailing Stop tətbiq olunmadı?

### Ox 5: Çatışmazlıqlar və Riyazi Təkliflər (Deficiency Report)
* Auditor subagent kod YAZMIR; yalnız çatışmazlıqları nömrələyir (`[DEF-01]`, `[DEF-02]`) və riyazi/parametrik həll yolunu təsvir edir.

---

## 5. İcra Prosesi (İşin Bölüşdürülməsi)

1. **İstifadəçi Tələbi:** İstifadəçi yeni söhbətdə ticarət loqlarını və performansı analiz etməyi istəyir.
2. **Subagentin İşi (Audit):**
   * Əsas agent `research` subagentini işə salır.
   * Subagent `TradeOS-v2` loqlarını, 500 şamı və Binance çıxarışlarını oxuyur.
   * `DEFICIENCY_REPORT` hazırlayır və əsas agentə təhvil verir.
3. **Əsas Agentin İşi (Texniki İcra):**
   * Hesabatı istifadəçiyə təqdim edir.
   * Razılaşdırılmış qüsurlar üçün `apps/server/src/...` və ya `apps/web/src/...` daxilində kod düzəlişlərini icra edir.
   * `npm run build` ilə build edir, serveri yeniləyir və nəticəni faktiki sübutla istifadəçiyə çatdırır.

---

## 6. Anti-Patterns & Qadağalar

* ❌ **Auditor subagentin fayl redaktə etməsi QƏTİ QADAĞANDIR.**
* ❌ **Köhnə `c:\Users\HP\TradeOS` (v1) qovluğuna və fayllarına müraciət QƏTİ QADAĞANDIR.**
* ❌ **Səthi təriflər ("hər şey yaxşıdır", "sistem mükəmməldir") QƏTİ QADAĞANDIR.**
* ❌ **Faktiki çıxarış və loq olmadan fikir bildirmək QƏTİ QADAĞANDIR.**
