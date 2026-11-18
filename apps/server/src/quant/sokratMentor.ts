/**
 * TradeOS v2 — Deterministic Sokrat Mentor
 * Pure Azerbaijani anti-gambling counsel, discipline reminders, and risk score calculation.
 * Zero hallucination, zero English fallbacks.
 */

import type { MentorBrief, RiskStateRecord, TechnicalSummary } from '@tradeos/shared';

export function generateMentorBrief(
  marketState: { indicators?: TechnicalSummary | null; markPrice?: number },
  riskState: RiskStateRecord,
  now: number = Date.now()
): MentorBrief {
  // Mode 1: LOCKOUT (Active 15-minute Cooldown)
  if (riskState.cooldown_until && now < riskState.cooldown_until) {
    const remainingMin = Math.ceil((riskState.cooldown_until - now) / 60000);
    const reasonText =
      riskState.cooldown_reason === '2_CONSECUTIVE_LOSSES'
        ? 'Ardıcıl 2 zərərli əməliyyat qeydə alındı'
        : 'Sessiya maksimum drawdown həddi (-3%) aşıldı';

    return {
      mode: 'LOCKOUT',
      headlineAz: `Soyuma Kilidi Aktivdir (${remainingMin} dəqiqə qalıb)`,
      adviceAz:
        "Dayan, dostum və dərindən nəfəs al. Birja səndən qisas alacağın bir düşmən deyil; qisas ticarəti (revenge trading) yalnız tamah və qəzəbin tələsidir. Sokrat deyir: 'Özünü tanı və hisslərinin ağası ol.' Bu 15 dəqiqə ərzində ekranı bağla, bir stəkan təmiz su iç və zehnini sakitləşdir. Bazar heç yerə qaçmır, amma intizamsız kapital bir göz qırpımında yox olur.",
      reasonsAz: [reasonText, 'Qisas ticarətinə qarşı qorunma məqsədilə sifariş girişi bloklanıb'],
      riskScore: 100,
    };
  }

  // Mode 2: CAUTION
  // Triggered on 1 loss, negative session pnl, or extreme RSI
  const rsi = marketState.indicators?.rsi14;
  const isExtremeRsi = rsi !== null && rsi !== undefined && (rsi >= 75 || rsi <= 25);
  const hasRecentLoss = riskState.consecutive_losses === 1 || riskState.session_net_pnl < 0;

  if (hasRecentLoss || isExtremeRsi) {
    const reasons: string[] = [];
    if (riskState.consecutive_losses === 1) reasons.push('Son əməliyyat zərərlə bağlanıb');
    if (riskState.session_net_pnl < 0) {
      reasons.push(`Sessiya cari zərərdədir: $${riskState.session_net_pnl.toFixed(2)}`);
    }
    if (isExtremeRsi) reasons.push(`RSI kənar zonadadır (${rsi}): ifrat alış/satış riski`);

    return {
      mode: 'CAUTION',
      headlineAz: 'Ehtiyatlı Ol — Risk Nəzarətini Gücləndir',
      adviceAz:
        'Bazar tələsməyi sevmir. Növbəti əməliyyata girməzdən əvvəl Stop-Loss səviyyəsini ikiqat yoxla və marjanı 5%-dən yuxarı qaldırma. Səbr ən güclü kapitaldır.',
      reasonsAz: reasons,
      riskScore: 65,
    };
  }

  // Mode 3: AGGRESSIVE (Trending opportunity)
  const adx = marketState.indicators?.adx14?.adx;
  const isStrongTrend = adx !== null && adx !== undefined && adx >= 25;
  if (isStrongTrend && rsi !== null && rsi !== undefined && rsi >= 45 && rsi <= 65) {
    return {
      mode: 'AGGRESSIVE',
      headlineAz: 'Trend İstiqamətində Fürsət',
      adviceAz:
        'Güclü bazar trendi müşahidə olunur. Planına uyğun olaraq, 10% marja cap-ını pozmadan TP1 və TP2 pillələri ilə hərəkət et.',
      reasonsAz: [`ADX göstəricisi trendin gücünü təsdiqləyir (${adx})`, 'RSI tarazlıq zonasındadır'],
      riskScore: 40,
    };
  }

  // Mode 4: DISCIPLINE (Standard default)
  return {
    mode: 'DISCIPLINE',
    headlineAz: 'İntizamlı Ticarət Rejimi',
    adviceAz:
      'Planına sadiq qal. Tələsmədən, yalnız texniki göstəricilər və risk qaydaları təsdiqlədikdə əməliyyata daxil ol.',
    reasonsAz: ['Risk parametrləri normal sərhəddədir', 'Cooldown kilidi aktiv deyil'],
    riskScore: 25,
  };
}
