# FiosFón

**FiosFón** helps you understand what your iOS apps collect about you.  
It analyses the public *App Store privacy labels* for popular apps in Ireland — showing what data is used to track you, what’s linked to your identity, and what’s not. Each app also includes a simple *Data Collection Intensity* meter for clarity.

🌐 **Live site:** [https://maidhci.github.io/fiosfon/](https://maidhci.github.io/fiosfon/)

---

## 🧭 Overview

- **Top Charts:** Automatically updated lists of the top Free, Paid, and Game apps (iOS · IE).  
- **Search:** Instantly look up any iOS app and view its privacy summary.  
- **Rights:** Learn about your data rights under GDPR and the Irish Data Protection Act 2018.  
- **Drawer Details:** Tap any data-type chip (e.g. *Identifiers*, *Purchases*) to view plain-English definitions and app-specific disclosures.

---

## ⚙️ How It Works

FiosFón uses:
- Apple’s public [RSS feeds](https://itunes.apple.com/ie/rss) for app rankings.
- The iTunes Search API for extra app metadata.
- Locally stored JSON files (`/data/apps.json`, `/data/rights_ie.json`) for detailed privacy data.
- Client-side JavaScript to merge and visualise everything—no backend required.

---

## 🧩 Structure
fiosfon/
├── data/
│   ├── apps.json              # Local dataset of app privacy details
│   ├── rights_ie.json         # User rights info (GDPR, DPC)
│   └── glossary.json          # Definitions for data categories
├── index.html                 # Main page
├── script.js                  # Core logic
├── styles.css                 # Site styles
└── README.md                  # This file
---

## 🧱 Tech Stack

- **HTML5 + CSS3** (static site, responsive design)
- **Vanilla JavaScript (ES6+)**
- **GitHub Pages** (for hosting and auto-deploy via Actions)
- Optional: *Images.weserv.nl proxy* for secure app icons

---

## 🧠 Roadmap

- [ ] Add *Data Linked / Not Linked* icons to match App Store design  
- [ ] Expand international support (UK, EU)  
- [ ] Introduce opt-in email/RSS updates  
- [ ] Add dark mode  

---

## 📜 Disclaimer

FiosFón is an educational tool. It provides general guidance based on public data from Apple.  
It is **not legal advice**. Always review each app’s official privacy policy for complete information.

---

## 💚 Author

Developed by **Maidhcí Ó Súilleabháin**  
📍 Made in Ireland  
🔗 [GitHub Profile](https://github.com/maidhci)

---
