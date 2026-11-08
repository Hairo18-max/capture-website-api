const {getSecret} = require('./config.js');
const puppeteer = require('puppeteer-core');
const chromium = require("@sparticuz/chromium");

async function doCaptureWork(queryParameters) {
    const options = await getOptions(queryParameters);
    const url = options.url;
    console.info('Capturing URL: ' + url + ' ...');
    return await tryWithPuppeteer(url, options);
}

function allowedRequest(queryParameters) {
    const secret = getSecret();
    if (!secret) {
        return true;
    }
    if (!queryParameters || !queryParameters.secret) {
        return false;
    }
    return queryParameters.secret === secret;
}

async function getOptions(queryParameters) {
    const result = parseQueryParameters(queryParameters);
    result.launchOptions = {
        headless: true,
        args: [
            ...chromium.default.args,
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--hide-scrollbars',
            '--mute-audio',
            "--disable-gpu",
            "--disable-dev-shm-usage",
            "--disable-setuid-sandbox",
            "--no-first-run",
            "--no-zygote",
            '--use-fake-ui-for-media-stream' // Pages that ask for webcam/microphone access
        ],
        executablePath: process.env.CHROME_EXECUTABLE_PATH || await chromium.default.executablePath(),
    };
    fieldValuesToNumber(result, 'width', 'height', 'quality', 'scaleFactor', 'timeout', 'delay', 'offset');
    return result;
}

function parseQueryParameters(queryParameters) {
    return Object.keys(queryParameters).reduce((params, key) => {
        const q = queryParameters[key];
        let value;
        try {
            value = JSON.parse(q);
        } catch {
            value = q
        }
        return {
            ...params,
            [key]: value
        }
    }, queryParameters || {});
}

async function tryWithPuppeteer(url, options) {
    try {
        const buffer = await takePlainPuppeteerScreenshot(url, options);
        console.info(`Successfully captured URL: ${url}`);
        return {
            statusCode: 200,
            responseType: getResponseType(options),
            buffer: buffer
        }
    } catch (e) {
        console.log('Capture failed due to: ' + e.message);
        return {
            statusCode: 500,
            message: e.message
        }
    }
}

async function takePlainPuppeteerScreenshot(url, options) {
    options.encoding = 'binary';
    options.wait_before_screenshot_ms = options.wait_before_screenshot_ms || 300;
    let browser;
    let page;
    let buffer;

    try {
        browser = await puppeteer.launch(options.launchOptions);
        page = await browser.newPage();

        // Prefer dark themes on websites that support the browser preference.
        await page.emulateMediaFeatures([
            { name: 'prefers-color-scheme', value: 'dark' }
        ]);

        await page.goto(url);
        await setViewport(page, options);
        await new Promise(r => setTimeout(r, options.wait_before_screenshot_ms));

        // TEMPORARY MAL DOM INSPECTION — does not click anything.
        const hostname = new URL(url).hostname;
        if (hostname === 'myanimelist.net' || hostname.endsWith('.myanimelist.net')) {
            const diagnostic = await page.evaluate(() => {
                const phrase = 'do not process my personal information';
                const all = Array.from(document.querySelectorAll('body *'));

                const matches = all.filter(element =>
                    (element.innerText || element.textContent || '')
                        .toLowerCase().includes(phrase)
                ).sort((a, b) =>
                    (a.innerText || a.textContent || '').length -
                    (b.innerText || b.textContent || '').length
                );

                const describe = element => {
                    const rect = element.getBoundingClientRect();
                    const style = getComputedStyle(element);

                    return {
                        tag: element.tagName,
                        id: element.id || '',
                        class: typeof element.className === 'string'
                            ? element.className.slice(0, 180) : '',
                        role: element.getAttribute('role'),
                        ariaLabel: element.getAttribute('aria-label'),
                        title: element.getAttribute('title'),
                        text: (element.innerText || element.textContent || '')
                            .trim().replace(/\s+/g, ' ').slice(0, 120),
                        rect: {
                            x: Math.round(rect.x),
                            y: Math.round(rect.y),
                            width: Math.round(rect.width),
                            height: Math.round(rect.height)
                        },
                        display: style.display,
                        visibility: style.visibility
                    };
                };

                const ancestors = [];
                if (matches.length) {
                    let element = matches[0];
                    for (let i = 0; element && i < 9; i++, element = element.parentElement) {
                        ancestors.push(describe(element));
                    }
                }

                const controls = all.filter(element =>
                    element.matches(
                        'button, [role="button"], a, [tabindex], [aria-label], [title]'
                    )
                ).map(describe).filter(item =>
                    item.rect.width > 0 &&
                    item.rect.height > 0 &&
                    item.rect.x < window.innerWidth &&
                    item.rect.y < window.innerHeight &&
                    item.rect.x + item.rect.width > 0 &&
                    item.rect.y + item.rect.height > 0
                ).sort((a, b) => {
                    const centerX = window.innerWidth / 2;
                    const centerY = window.innerHeight / 2;
                    const distance = item =>
                        Math.abs(item.rect.x + item.rect.width / 2 - centerX) +
                        Math.abs(item.rect.y + item.rect.height / 2 - centerY);
                    return distance(a) - distance(b);
                }).slice(0, 25);

                return {
                    viewport: {
                        width: window.innerWidth,
                        height: window.innerHeight
                    },
                    phraseFound: matches.length,
                    matchingElements: matches.slice(0, 5).map(describe),
                    ancestors,
                    nearbyControls: controls
                };
            });

            console.info('MAL DOM DIAGNOSTIC: ' + JSON.stringify(diagnostic));
        }

        const array = await page.screenshot();
        buffer = Buffer.from(array);
    } catch (e) {
        console.error('Error during Puppeteer screenshot capture: ', e);
    } finally {
        if (browser) {
            await browser.close();
        }
    }

    return buffer;
}

async function setViewport(page, options) {
    if (options.width && options.height) {
        const viewportOptions = {
            width: options.width,
            height: options.height,
            deviceScaleFactor: options.scaleFactor ? options.scaleFactor : 1
        };
        await page.setViewport(viewportOptions);
    }
}

function getResponseType(queryParams) {
    if (queryParams.type && queryParams.type === 'jpeg') {
        return 'jpg';
    }
    return 'png';
}

function fieldValuesToNumber(obj, ...fields) {
    fields.forEach(f => {
        if (obj[f]) {
            const val = Number(obj[f]);
            obj[f] = Number.isNaN(val) ? obj[f] : val;
        }
    });
}

module.exports = {
    doCaptureWork: doCaptureWork,
    allowedRequest: allowedRequest,
    getResponseType: getResponseType,
    fieldValuesToNumber: fieldValuesToNumber
}
