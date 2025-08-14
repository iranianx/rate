# format-f1dx v1

## سرِ فایل‌های روزانه (F1)
- asof: YYYY-MM-DD
- tz: Europe/Istanbul
- updated_at: YYYY-MM-DDThh:mm:ss+03:00
- version: v1
- unit_all: TMN
- sources.usd: [Herat_Tomen, dollar_tehran3bze, dollar_sulaymaniyah, bonbast]
- sources.usdt: [AbanTetherPrice, TetherLand]

## items هر رکورد
- code, name, value, rule_key
- delta_pct: درصد تغییر نسبت به دیروز (علامت‌دار)
- delta_flag: one of [green, blue, red]
- notes: متن کوتاه منبع/حذف‌ها

## قوانین
- پرت USD: خارج از ±5% نسبت به بازهٔ [min..max] دیگر منابع → حذف.
- USD: میانگینِ منابعِ باقی‌مانده → رُند.
- USDT (مرحله ۱): حذف منابعی که >3% با USDT_مرجع (از USD) اختلاف دارند؛ از باقی‌مانده میانگین.
- USDT (مرحله ۲ همگرایی): اگر میانگین USDT با USDT_مرجع >±1% بود → میانگین دوبارهٔ این دو عدد → رُند.
- مثلث‌ها: >+1% → blue؛ <−1% → red؛ بین ±1% → green.
- رُند: ≥50000 → نزدیک‌ترین 100؛ 10000–49999 → نزدیک‌ترین 50؛ 1000–9999 → نزدیک‌ترین 10؛ <1000 → عدد صحیح.
- اختتام روز (23:00 Europe/Istanbul): اسنپ‌شات به y2025/f1yx.json + ثبت دلایل عدم‌استفادهٔ منابع.
