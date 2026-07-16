# DSE Scraper → Supabase

এটি একটি GitHub Actions-ভিত্তিক স্ক্র্যাপার যা প্রতি ১০ মিনিটে DSE/CSE থেকে মার্কেট ডেটা সংগ্রহ করে Supabase-এ আপলোড করে।

## 🚀 সেটআপ

1. এই রিপোজিটরি ক্লোন করুন
2. `npm install` রান করুন
3. `.env` ফাইল তৈরি করে প্রয়োজনীয় ভেরিয়েবল দিন
4. `npm test` (ড্রাই রান) করে দেখুন
5. GitHub রিপোজিটরিতে Push করুন
6. GitHub Secrets-এ `SUPABASE_URL` ও `SUPABASE_SERVICE_KEY` যোগ করুন

## 🧪 লোকালি টেস্ট

```bash
npm start -- --dry-run   # ড্রাই রান
npm start                # আসল রান
