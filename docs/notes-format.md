# notes format (الگوی کوتاه و ثابت)

## ساختار کلی
notes = "src_used=<LIST>; excl={<MAP>}; info=<TAG>[; extra=<FREE>]"

- src_used : لیست منابع استفاده‌شده با نام کوتاه (کاما جدا)
- excl     : لیست منابعی که استفاده نشده‌اند + دلیل حذف
- info     : یک برچسب توضیحی خیلی کوتاه برای روش محاسبه
- extra    : اختیاری (مثلاً هشدار یا توضیح فنی کوتاه)

## کُدهای دلیل حذف (excl)
- closed                : کانال/سایت بسته یا در دسترس نبود
- no_data               : امروز عدد اعلام نکرد
- outlier_5pct          : پرت نسبت به بازهٔ min..max (ویژه USD)
- outlier_3pct_vs_usd   : پرت نسبت به USDT مرجع بر اساس USD (ویژه USDT)
- fx_gap                : نسبت جهانی به USD غیرعادی یا ناقص

## برچسب‌های info (نمونه‌های مجاز)
- near-mean       : انتخاب نزدیک به میانگین/میانه پس از حذف پرت‌ها
- avg             : میانگین ساده
- avg_reconciled  : میانگین پس از آشتی با مقدار مرجع (قاعده ±1٪)
- usd_base        : محاسبه بر پایهٔ USD تومانی و نسبت جهانی
- rounded         : فقط اشاره به رُند نهایی (وقتی لازم است)

## مثال‌ها

### USD
src_used=Herat,Tehran3bze,Bonbast; excl={Slemani:closed}; info=near-mean

### USDT
src_used=Aban,TetherLand; excl={TetherLand:outlier_3pct_vs_usd}; info=avg_reconciled

### EUR (بر پایه USD)
src_used=fx_table; excl={}; info=usd_base

### با هشدار پرش غیرعادی (فقط اعلام)
src_used=Herat,Tehran3bze,Bonbast; excl={Slemani:no_data}; info=near-mean; extra=jump_note
