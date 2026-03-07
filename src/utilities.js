const urlIcon = {
	// General Websites
	"google.com": ":LiSearch:",           // Search Engine
	"youtube.com": ":LiYoutube:",         // Video-sharing platform
	"facebook.com": ":LiFacebook:",       // Social Media Network
	"instagram.com": ":LiCamera:",     	  // Social Media Network
	"whatsapp.com": ":LiChat:",           // Messaging Service
	"x.com": ":LiTwitter:",               // Social Media Network
	"wikipedia.org": ":LiBook:",          // Encyclopedia
	"chatgpt.com": ":LiBrain:",           // AI Chatbot
	"reddit.com": ":LiReddit:",           // Social Media Network
	"yahoo.com": ":LiYahoo:",             // Web Portal and Search Engine
	"amazon.com": ":LiShoppingCart:",     // E-commerce Platform
	"wayfair.com": ":LiShoppingCart:",
	"homedepot.com": ":LiShoppingCart:",
	"yandex.ru": ":LiSearch:",            // Search Engine
	"baidu.com": ":LiSearch:",            // Search Engine
	"netflix.com": ":LiFilm:",            // Streaming Service
	"bing.com": ":LiSearch:",             // Search Engine
	"linkedin.com": ":LiLinkedIn:",       // Professional Networking
	"live.com": ":LiMail:",               // Email Service
	"pinterest.com": ":LiCamera:",        // Social Media Network
	"duckduckgo.com": ":LiSearch:",       // Search Engine
	"telegram.org": ":LiTelegram:",       // Messaging Service
	"twitch.tv": ":LiTwitch:",            // Live Streaming Platform
	"weather.com": ":LiWeather:",         // Weather Information
	"quora.com": ":LiQuestion:",          // Q&A Platform
	"temu.com": ":LiShoppingCart:",       // E-commerce Platform
	"ebay.com": ":LiShoppingCart:",       // E-commerce Platform
  
	// News Websites
	"nytimes.com": ":LiNewspaper:",            // The New York Times
	"cnn.com": ":LiNewspaper:",                // CNN
	"bbc.com": ":LiNewspaper:",                // BBC News
	"foxnews.com": ":LiNewspaper:",            // Fox News
	"washingtonpost.com": ":LiNewspaper:",     // The Washington Post
	"theguardian.com": ":LiNewspaper:",        // The Guardian
	"wsj.com": ":LiNewspaper:",                // The Wall Street Journal
	"usatoday.com": ":LiNewspaper:",           // USA Today
	"latimes.com": ":LiNewspaper:",            // Los Angeles Times
	"nbcnews.com": ":LiNewspaper:",            // NBC News
	"dailymail.co.uk": ":LiNewspaper:",        // Daily Mail
	"huffpost.com": ":LiNewspaper:",           // HuffPost
	"reuters.com": ":LiNewspaper:",            // Reuters
	"forbes.com": ":LiNewspaper:",             // Forbes
	"bloomberg.com": ":LiNewspaper:",          // Bloomberg
	"abcnews.go.com": ":LiNewspaper:",         // ABC News
	"cbsnews.com": ":LiNewspaper:",            // CBS News
	"npr.org": ":LiNewspaper:",                // NPR
	"news.yahoo.com": ":LiNewspaper:",         // Yahoo News
	"politico.com": ":LiNewspaper:",           // Politico

	// Payment and Banking
	"paypal.com": ":LiCreditCard:",             // Online Payment Platform
	"venmo.com": ":LiCreditCard:",              // Mobile Payment Service
	"cash.app": ":LiCreditCard:",               // Mobile Payment Service
	"coinbase.com": ":LiBitcoin:",              // Cryptocurrency Exchange
	"blockchain.com": ":LiBitcoin:",            // Cryptocurrency Wallet
	"robinhood.com": ":LiDollarSign:",          // Stock Trading Platform
	"coinmarketcap.com": ":LiBitcoin:",         // Cryptocurrency Market Data
	"bankofamerica.com": ":LiDollarSign:",      // Bank

	// Productivity
	"mail.google.com": ":LiMail:",
	"docs.google.com": ":LiFile:",
	"maps.google.com": ":LiMap:",
	"drive.google.com": ":LiFile:",
	"box.com": ":LiFile:",
	"investomation.com": ":LiMap:",
	'github.com': ':LiCode:',
	'atlassian.com': ':LiCode:',
	"stackoverflow.com": ":LiCode:",
	"figma.com": ":LiFigma:",
	"trello.com": ":LiTable:",
	"notion.so": ":LiTable:",
	"airtable.com": ":LiTable:",
	"asana.com": ":LiTable:",
  
	// Educational and Government
	"edu": ":LiLibrary:",                 // Educational Institutions
	"gov": ":LiCrown:",                   // Government Websites
};
export function getIconForUrl(url) {
	// const baseHost = url.hostname.replace("www.", "")
	// return urlIcon[baseHost] ?? ":LiLink:"
	// try to apply subdomain first
	if (url.hostname in urlIcon) {
		return urlIcon[url.hostname]
	}
	// then start stripping subdomains
	const parts = url.hostname.split('.')
	for (let i = 1; i < parts.length; i++) {
		const baseHost = parts.slice(i).join('.')
		if (baseHost in urlIcon) {
			return urlIcon[baseHost]
		}
	}
	return ":LiLink:";
}

export function escapeRegex(str) {
	// Escape special characters in the identifier so they are treated literally
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const urlRegex = /((https?|ftp):\/\/[^\s/$.?#].[^\s()]*)/i;
export const isUrl = (str) => {
	// Anchor it to match the entire line:
	const anchoredRegex = new RegExp(`^${urlRegex.source}$`, urlRegex.flags);
  
	// If regex doesn't match as a full line, return false immediately
	if (!anchoredRegex.test(str)) {
	  	return false;
	}
  
	// Then validate by actually constructing a URL
	try {
	  	new URL(str);
	  	return true;
	} catch (e) {
	  	return false;
	}
}
export const lineHasUrl = (line) => {
	return urlRegex.test(line);
}
export const extractUrl = (line) => {
	const match = line.match(urlRegex);
	return match ? match[0] : null;
}

export function generateId(length) {
	return Math.random().toString(36).substring(2, length / 2) + Math.random().toString(36).substring(2, length / 2)
}

// strips any markdown formatting from a string
export function normalizeConfigVal(value, stripUnderscores = true) {
	// for underscores, only strip them if they surround the text
	// if they're in the middle of the text or only one side, they're probably intentional
	value = value.replace(/[*`"']/g, "").trim();
	if (stripUnderscores && value.startsWith("_") && value.endsWith("_")) {
		value = value.slice(1, -1);
	}

	// convert boolean-like strings to actual booleans
	if (value === "true") {
		return true;
	} else if (value === "false") {
		return false;
	}

	// convert number-like strings to actual numbers
	const num = Number(value);
	if (!isNaN(num)) {
		return num;
	}

	return value;
}

export function parseISODuration(iso) {
    // quick & light – good enough for PT5M, P1D, etc.
    const dur = window.moment.duration(iso);
    return dur.asMilliseconds();
}

export function normalizeInterval(raw) {
	const match = raw.match(/^(\d+)([mhdwM])$/i);
	if (!match) return raw;               // assume user already gave ISO-8601
	const [, n, unit] = match;
	switch (unit.toLowerCase()) {
	  case 'm': return `PT${n}M`;  // minutes
	  case 'h': return `PT${n}H`;  // hours
	  case 'd': return `P${n}D`;   // days
	  case 'w': return `P${n}W`;   // weeks
	  case 'M': return `P${n}M`;   // months
	  default : throw new Error('Unsupported interval');
	}
}

// ─────────────────────────────────────────────────────────────
// TIME HELPERS (slot-based scheduler; 1-minute granularity)
// ─────────────────────────────────────────────────────────────
export const SLOT_MS = 60 * 1000;          	// slot granularity
export const MIN_INTERVAL = 1 * 60 * 1000;  // maximum message frequency

// next aligned moment in the future that is a multiple of SLOT_MS
export function nextSlot(now = Date.now()) {
  return Math.ceil(now / SLOT_MS) * SLOT_MS;
}

// round-up so tasks fire on “neat” boundaries (5m, 15m, etc.)
export function alignedNextDue(interval, now = Date.now()) {
  return Math.ceil(now / interval) * interval;
}

/* NEW: tiny string-template helper for pretty log lines                 */
export function applyTemplate(tpl, data) {
	return tpl.replace(/\{([^}]+)}/g, (_, path) =>
	  path.split('.').reduce((o, k) => (o ? o[k] : ''), data)
	);
}