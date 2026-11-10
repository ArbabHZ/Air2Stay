// News & events content, edited by the team. Plain JSON after "= " so that
// src/build_event_evidence.py can read the same calendar.
// Rules: every date needs a source link; "upcoming" lists only announced dates;
// news items keep the publisher's headline, a link and our own short summary
// (no copied article text or photos). Dates are local dates in Abu Dhabi.
// "image" is a file name in prototype/images/news-events/ (svg, png, jpg or webp);
// see the README there to use your own pictures. "imageCredits" holds the
// author and licence for each picture taken from Wikimedia Commons.
export const NEWS_EVENTS = {
  "version": 1,
  "imageCredits": {
    "event-f1.jpg": {
      "author": "Berik from United Kingdom",
      "licence": "CC BY-SA 2.0",
      "licenceUrl": "https://creativecommons.org/licenses/by-sa/2.0",
      "source": "https://commons.wikimedia.org/wiki/File:2015_Abu_Dhabi_Grand_Prix_-_Race_start_(22882439484).jpg",
      "site": "Wikimedia Commons",
      "cropped": true
    },
    "event-adipec.jpg": {
      "author": "Aravind Sivaraj",
      "licence": "CC BY-SA 3.0",
      "licenceUrl": "https://creativecommons.org/licenses/by-sa/3.0",
      "source": "https://commons.wikimedia.org/wiki/File:Abu_Dhabi_National_Exhibitions_Company_(ADNEC),_Abu_Dhabi,_UAE.JPG",
      "site": "Wikimedia Commons",
      "cropped": true
    },
    "event-idex.jpg": {
      "author": "Cezary Filip Krzymowski",
      "licence": "CC BY 4.0",
      "licenceUrl": "https://creativecommons.org/licenses/by/4.0",
      "source": "https://commons.wikimedia.org/wiki/File:Model_pojazdu_Warana_na_targach_IDEX_2025.jpg",
      "site": "Wikimedia Commons",
      "cropped": true
    },
    "news-flights.jpg": {
      "author": "Steven He",
      "licence": "Public domain",
      "licenceUrl": "",
      "source": "https://commons.wikimedia.org/wiki/File:Etihad_Airways_B787-9.jpg",
      "site": "Wikimedia Commons",
      "cropped": true
    },
    "news-tourism.jpg": {
      "author": "Raganesh",
      "licence": "CC BY-SA 3.0",
      "licenceUrl": "https://creativecommons.org/licenses/by-sa/3.0",
      "source": "https://commons.wikimedia.org/wiki/File:Abu_Dhabi_Skyline_from_Breakwaters_Marina.jpg",
      "site": "Wikimedia Commons",
      "cropped": true
    },
    "news-events.jpg": {
      "author": "Delta.jpg",
      "licence": "CC BY-SA 4.0",
      "licenceUrl": "https://creativecommons.org/licenses/by-sa/4.0",
      "source": "https://commons.wikimedia.org/wiki/File:Etihad_Airways_Flyover_-_Yas_Island,_Abu_Dhabi_Grand_Prix_(2).jpg",
      "site": "Wikimedia Commons",
      "cropped": true
    },
    "event-adibf.jpg": {
      "author": "Reda Kerbush",
      "licence": "CC BY-SA 4.0",
      "licenceUrl": "https://creativecommons.org/licenses/by-sa/4.0",
      "source": "https://commons.wikimedia.org/wiki/File:ADIBF5.jpg",
      "site": "Wikimedia Commons",
      "cropped": true
    }
  },
  "events": [
    {
      "id": "f1",
      "name": "Formula 1 Abu Dhabi Grand Prix",
      "nameAr": "سباق جائزة أبوظبي الكبرى للفورمولا 1",
      "venue": "Yas Marina Circuit",
      "venueAr": "حلبة مرسى ياس",
      "category": "sport",
      "image": "event-f1.jpg",
      "editions": [
        { "id": "f1-2022", "start": "2022-11-18", "end": "2022-11-20", "source": "https://www.thenationalnews.com/sport/f1/2022/11/16/abu-dhabi-grand-prix-2022-whats-happening-when-and-where-at-yas-marina-circuit" },
        { "id": "f1-2023", "start": "2023-11-24", "end": "2023-11-26", "source": "https://formula1.com/en/latest/article.what-time-is-the-formula-1-2023-abu-dhabi-grand-prix-and-how-can-i-watch-it.5xhjMamN5BpADzFVCDYKJt.html" },
        { "id": "f1-2024", "start": "2024-12-05", "end": "2024-12-08", "source": "https://www.zawya.com/en/press-release/events-and-conferences/yas-marina-circuit-to-host-final-race-of-record-breaking-f1-2024-season-from-december-5-8-next-year-tbqmch4z" },
        { "id": "f1-2025", "start": "2025-12-05", "end": "2025-12-07", "source": "https://formula1.com/en/latest/article/formula-1-etihad-airways-abu-dhabi-grand-prix-2025.41QAujgesmht3sNpc90rUR" },
        { "id": "f1-2026", "start": "2026-12-03", "end": "2026-12-06", "source": "https://gulfnews.com/business/tourism/prices-revealed-abu-dhabi-grand-prix-2026-packages-open-with-f1-tickets-hotel-stays-and-concert-access-1.500568303" }
      ]
    },
    {
      "id": "adipec",
      "name": "ADIPEC",
      "nameAr": "معرض ومؤتمر أبوظبي الدولي للبترول (أديبك)",
      "venue": "ADNEC Centre Abu Dhabi",
      "venueAr": "مركز أدنيك أبوظبي",
      "category": "exhibition",
      "image": "event-adipec.jpg",
      "nextNote": "2027 dates not announced yet",
      "editions": [
        { "id": "adipec-2022", "start": "2022-10-31", "end": "2022-11-03", "source": "https://www.tradefairdates.com/ADIPEC-M1677/Abu-Dhabi.html" },
        { "id": "adipec-2023", "start": "2023-10-02", "end": "2023-10-05", "source": "https://offshore-energy.biz/?p=660449" },
        { "id": "adipec-2024", "start": "2024-11-04", "end": "2024-11-07", "source": "https://www.compressortech2.com/news/adipec-announces-new-dates/8035575.article" },
        { "id": "adipec-2025", "start": "2025-11-03", "end": "2025-11-06", "source": "https://www.tradefairdates.com/ADIPEC-M1677/Abu-Dhabi.html" },
        { "id": "adipec-2026", "start": "2026-11-02", "end": "2026-11-05", "source": "https://petroleumaustralia.com.au/events/adipec/" }
      ]
    },
    {
      "id": "idex",
      "name": "IDEX and NAVDEX",
      "nameAr": "معرض الدفاع الدولي (آيدكس) ومعرض الدفاع البحري (نافدكس)",
      "venue": "ADNEC Centre Abu Dhabi",
      "venueAr": "مركز أدنيك أبوظبي",
      "category": "exhibition",
      "image": "event-idex.jpg",
      "editions": [
        { "id": "idex-2023", "start": "2023-02-20", "end": "2023-02-24", "source": "https://www.mediaoffice.abudhabi/en/security/under-the-patronage-of-the-UAE-president-international-defence-exhibition-idex-and-naval-defence-exhibition-navdex-to-take-place-in-abu-dhabi/" },
        { "id": "idex-2025", "start": "2025-02-17", "end": "2025-02-21", "source": "https://www.mediaoffice.abudhabi/en/abu-dhabi-events/international-defence-exhibition-idex-2025/" },
        { "id": "idex-2027", "start": "2027-01-21", "end": "2027-01-25", "source": "https://www.adnecgroup.ae/news-media/news/details/dates-for-idex-and-navdex-2027-confirmed-with-70-of-exhibitors-committing-to-the-next-edition" }
      ]
    },
    {
      "id": "adibf",
      "name": "Abu Dhabi International Book Fair",
      "nameAr": "معرض أبوظبي الدولي للكتاب",
      "venue": "ADNEC Centre Abu Dhabi",
      "venueAr": "مركز أدنيك أبوظبي",
      "category": "culture",
      "image": "event-adibf.jpg",
      "editions": [
        { "id": "adibf-2022", "start": "2022-05-23", "end": "2022-05-29", "source": "https://www.thenationalnews.com/arts-culture/books/2022/04/30/abu-dhabi-international-book-fair-2022-announces-dates-what-to-expect" },
        { "id": "adibf-2023", "start": "2023-05-22", "end": "2023-05-28", "source": "https://www.ots.at/presseaussendung/OTS_20230503_OTS0140/nur-noch-wenige-wochen-bis-zur-32-ausgabe-der-abu-dhabi-international-book-fair" },
        { "id": "adibf-2024", "start": "2024-04-29", "end": "2024-05-05", "source": "https://www.mediaoffice.abudhabi/en/arts-culture/under-the-patronage-of-the-uae-president-theyab-bin-mohamed-bin-zayed-inaugurates-33rd-abu-dhabi-international-book-fair/" },
        { "id": "adibf-2025", "start": "2025-04-26", "end": "2025-05-05", "source": "https://www.thenationalnews.com/arts-culture/books/2025/04/24/abu-dhabi-book-fair-sessions-schedule" },
        { "id": "adibf-2026", "start": "2026-04-25", "end": "2026-05-04", "source": "https://gulfnews.com/uae/education/abu-dhabi-international-book-fair-dates-announced-until-2030-1.104469819" },
        { "id": "adibf-2027", "start": "2027-04-24", "end": "2027-05-03", "source": "https://gulfnews.com/uae/education/abu-dhabi-international-book-fair-dates-announced-until-2030-1.104469819" }
      ]
    }
  ],
  "holidays": [
    { "id": "ramadan-2022", "name": "Ramadan and Eid al-Fitr 2022", "start": "2022-04-02", "end": "2022-05-06", "source": "https://gulfnews.com/living-in-uae/ask-us/ramadan-2022-uae-working-hours-fasting-duration-eid-holiday--all-you-need-to-know-1.1647608690166" },
    { "id": "ramadan-2023", "name": "Ramadan and Eid al-Fitr 2023", "start": "2023-03-23", "end": "2023-04-25", "source": "https://gulfnews.com/uae/ramadan/eid-al-fitr-2023-uae-confirms-first-day-of-eid-1.1682002566971" },
    { "id": "ramadan-2024", "name": "Ramadan and Eid al-Fitr 2024", "start": "2024-03-11", "end": "2024-04-14", "source": "https://thenationalnews.com/news/uae/2024/04/08/eid-al-fitr-start-date-2024" },
    { "id": "ramadan-2025", "name": "Ramadan and Eid al-Fitr 2025", "start": "2025-03-01", "end": "2025-04-03", "source": "https://www.timeanddate.com/holidays/united-arab-emirates/2025" },
    { "id": "ramadan-2026", "name": "Ramadan and Eid al-Fitr 2026", "start": "2026-02-18", "end": "2026-03-24", "source": "https://publicholidays.ae/2026-dates/" },
    { "id": "adha-2022", "name": "Eid al-Adha 2022", "start": "2022-07-07", "end": "2022-07-13", "source": "https://www.timeanddate.com/holidays/united-arab-emirates/eid-al-adha" },
    { "id": "adha-2023", "name": "Eid al-Adha 2023", "start": "2023-06-26", "end": "2023-07-02", "source": "https://www.timeanddate.com/holidays/united-arab-emirates/eid-al-adha" },
    { "id": "adha-2024", "name": "Eid al-Adha 2024", "start": "2024-06-14", "end": "2024-06-20", "source": "https://www.timeanddate.com/holidays/united-arab-emirates/eid-al-adha" },
    { "id": "adha-2025", "name": "Eid al-Adha 2025", "start": "2025-06-04", "end": "2025-06-10", "source": "https://www.timeanddate.com/holidays/united-arab-emirates/2025" },
    { "id": "adha-2026", "name": "Eid al-Adha 2026", "start": "2026-05-25", "end": "2026-05-31", "source": "https://publicholidays.ae/2026-dates/" },
    { "id": "national-2026", "name": "National Day holiday 2026 (2-3 Dec, plus 2 buffer days)", "start": "2026-11-30", "end": "2026-12-03", "source": "https://publicholidays.ae/2026-dates/" },
    { "id": "yearend-2026", "name": "Year-end holiday season 2026 (method choice)", "start": "2026-12-20", "end": "2027-01-03", "source": "" },
    { "id": "national-2021", "name": "National Day holiday 2021 (2-3 Dec, plus 2 buffer days)", "start": "2021-11-30", "end": "2021-12-03", "source": "https://publicholidays.ae/2026-dates/" },
    { "id": "national-2022", "name": "National Day holiday 2022 (2-3 Dec, plus 2 buffer days)", "start": "2022-11-30", "end": "2022-12-03", "source": "https://publicholidays.ae/2026-dates/" },
    { "id": "national-2023", "name": "National Day holiday 2023 (2-3 Dec, plus 2 buffer days)", "start": "2023-11-30", "end": "2023-12-03", "source": "https://publicholidays.ae/2026-dates/" },
    { "id": "national-2024", "name": "National Day holiday 2024 (2-3 Dec, plus 2 buffer days)", "start": "2024-11-30", "end": "2024-12-03", "source": "https://publicholidays.ae/2026-dates/" },
    { "id": "national-2025", "name": "National Day holiday 2025 (2-3 Dec, plus 2 buffer days)", "start": "2025-11-30", "end": "2025-12-03", "source": "https://publicholidays.ae/2026-dates/" },
    { "id": "yearend-2021", "name": "Year-end holiday season 2021 (method choice)", "start": "2021-12-20", "end": "2022-01-03", "source": "" },
    { "id": "yearend-2022", "name": "Year-end holiday season 2022 (method choice)", "start": "2022-12-20", "end": "2023-01-03", "source": "" },
    { "id": "yearend-2023", "name": "Year-end holiday season 2023 (method choice)", "start": "2023-12-20", "end": "2024-01-03", "source": "" },
    { "id": "yearend-2024", "name": "Year-end holiday season 2024 (method choice)", "start": "2024-12-20", "end": "2025-01-03", "source": "" },
    { "id": "yearend-2025", "name": "Year-end holiday season 2025 (method choice)", "start": "2025-12-20", "end": "2026-01-03", "source": "" }
  ],
  "news": [
    {
      "id": "kt-2025-12-05-f1-hotel-rates",
      "date": "2025-12-05", "dateKind": "published",
      "source": "Khaleej Times",
      "url": "https://www.khaleejtimes.com/uae/abu-dhabi-grand-prix-hotel-rates-limited-parking",
      "headline": "Abu Dhabi Grand Prix: Over 1,600% spike in hotel rates, limited parking on F1 weekend",
      "summary": "Hotel prices on Yas Island rose sharply over the 2025 Grand Prix weekend compared with a normal February stay.",
      "summaryAr": "ارتفعت أسعار الفنادق في جزيرة ياس ارتفاعًا حادًا خلال عطلة سباق الجائزة الكبرى 2025 مقارنةً بإقامة عادية في فبراير.",
      "image": "news-events.jpg", "topic": "events", "eventId": "f1", "affects": []
    },
    {
      "id": "gn-2026-01-30-etihad-calgary",
      "date": "2026-01-30", "dateKind": "updated",
      "source": "Gulf News",
      "url": "https://gulfnews.com/business/aviation/etihad-launches-its-first-ever-nonstop-service-linking-abu-dhabi-with-a-new-long-haul-city-1.500425620",
      "headline": "Etihad launches its first-ever nonstop service linking Abu Dhabi with a new long-haul city",
      "summary": "Etihad's first nonstop Abu Dhabi–Calgary service starts on 3 November 2026.",
      "summaryAr": "تبدأ أول رحلة مباشرة للاتحاد للطيران بين أبوظبي وكالجاري في 3 نوفمبر 2026.",
      "image": "news-flights.jpg", "topic": "flights", "eventId": null, "affects": ["CANADA"]
    },
    {
      "id": "kt-2026-04-06-india-record",
      "date": "2026-04-06", "dateKind": "published",
      "source": "Khaleej Times",
      "url": "https://www.khaleejtimes.com/business/abu-dhabi-tourism-surges-to-record-high-as-indian-visitor-numbers-jump",
      "headline": "Abu Dhabi tourism surges to record high as Indian visitor numbers jump",
      "summary": "Abu Dhabi welcomed a record 26.6 million visitors in 2025, and India was the largest hotel market, up 22%.",
      "summaryAr": "استقبلت أبوظبي رقمًا قياسيًا بلغ 26.6 مليون زائر في 2025، وكانت الهند أكبر سوق لنزلاء الفنادق بزيادة 22%.",
      "image": "news-tourism.jpg", "topic": "tourism", "eventId": null, "affects": ["INDIA"]
    },
    {
      "id": "gn-2026-04-06-visitors-2025",
      "date": "2026-04-06", "dateKind": "updated",
      "source": "Gulf News",
      "url": "https://gulfnews.com/business/tourism/abu-dhabi-records-266m-visitors-in-2025-as-hotel-revenues-hit-dh91b-1.500497641",
      "headline": "Abu Dhabi records 26.6m visitors in 2025 as hotel revenues hit Dh9.1b",
      "summary": "Hotel revenues reached Dh9.1 billion in 2025, up 19.5%, with occupancy at 81%.",
      "summaryAr": "بلغت إيرادات الفنادق 9.1 مليار درهم في 2025 بزيادة 19.5%، مع نسبة إشغال 81%.",
      "image": "news-tourism.jpg", "topic": "tourism", "eventId": null, "affects": []
    },
    {
      "id": "gn-2026-04-13-etihad-china",
      "date": "2026-04-13", "dateKind": "updated",
      "source": "Gulf News",
      "url": "https://gulfnews.com/business/aviation/etihad-expands-china-network-with-5-new-routes-adds-28-weekly-flights-1.500504948",
      "headline": "Etihad expands China network with 5 new routes, adds 28 weekly flights",
      "summary": "Etihad adds Shanghai, Guangzhou, Chengdu, Hangzhou and Shenzhen, 28 more weekly flights, between October 2026 and March 2027.",
      "summaryAr": "تضيف الاتحاد للطيران شنغهاي وقوانغتشو وتشنغدو وهانغتشو وشنتشن، بـ28 رحلة أسبوعية إضافية بين أكتوبر 2026 ومارس 2027.",
      "image": "news-flights.jpg", "topic": "flights", "eventId": null, "affects": ["CHINA"]
    },
    {
      "id": "gn-2026-06-09-f1-2026-packages",
      "date": "2026-06-09", "dateKind": "updated",
      "source": "Gulf News",
      "url": "https://gulfnews.com/business/tourism/prices-revealed-abu-dhabi-grand-prix-2026-packages-open-with-f1-tickets-hotel-stays-and-concert-access-1.500568303",
      "headline": "Prices revealed: Abu Dhabi Grand Prix 2026 packages open with F1 tickets, hotel stays and concert access",
      "summary": "Grand Prix 2026 packages with a hotel stay and a four-day ticket start from Dh4,091 for three nights.",
      "summaryAr": "تبدأ باقات سباق الجائزة الكبرى 2026 التي تشمل الإقامة الفندقية وتذكرة لأربعة أيام من 4,091 درهمًا لثلاث ليالٍ.",
      "image": "news-events.jpg", "topic": "events", "eventId": "f1", "affects": []
    }
  ]
};
