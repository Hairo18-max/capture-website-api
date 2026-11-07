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

        // Close only the X control in MAL's privacy notice modal.
        const hostname = new URL(url).hostname;
        if (hostname === 'myanimelist.net' || hostname.endsWith('.myanimelist.net')) {
            const closed = await page.evaluate(() => {
                const phrase = 'do not process my personal information';

                const matchingElements = Array.from(document.querySelectorAll('body *'))
                    .filter(element => {
                        const text = (element.innerText || '').toLowerCase();
                        return text.includes(phrase) && text.length < 5000;
                    })
                    .sort((a, b) =>
                        (a.innerText || '').length - (b.innerText || '').length
                    );

                if (!matchingElements.length) return false;

                const viewportWidth = window.innerWidth;
                const viewportHeight = window.innerHeight;
                let modal = null;

                // Find the smallest centered ancestor large enough to be the modal.
                for (let element = matchingElements[0];
                     element && element !== document.body;
                     element = element.parentElement) {
                    const rect = element.getBoundingClientRect();

                    if (
                        rect.width >= viewportWidth * 0.45 &&
                        rect.height >= viewportHeight * 0.45 &&
                        Math.abs((rect.left + rect.right) / 2 - viewportWidth / 2) < viewportWidth * 0.25 &&
                        Math.abs((rect.top + rect.bottom) / 2 - viewportHeight / 2) < viewportHeight * 0.25
                    ) {
                        modal = element;
                        break;
                    }
                }

                if (!modal) return false;

                const candidates = Array.from(modal.querySelectorAll(
                    'button, [role="button"], a, [tabindex]'
                ));

                const closeCandidates = candidates.map(element => {
                    const rect = element.getBoundingClientRect();
                    const style = window.getComputedStyle(element);
                    const label = [
                        element.getAttribute('aria-label'),
                        element.getAttribute('title'),
                        element.innerText
                    ].filter(Boolean).join(' ').toLowerCase();

                    const visible =
                        rect.width >= 12 && rect.width <= 80 &&
                        rect.height >= 12 && rect.height <= 80 &&
                        style.display !== 'none' &&
                        style.visibility !== 'hidden';

                    const nearTopRight =
                        rect.left + rect.width / 2 > modal.getBoundingClientRect().right -
                            modal.getBoundingClientRect().width * 0.15 &&
                        rect.top + rect.height / 2 < modal.getBoundingClientRect().top +
                            modal.getBoundingClientRect().height * 0.15;

                    const hasCloseIcon =
                        !!element.querySelector('svg') ||
                        /close|dismiss|×|✕|✖/.test(label);

                    return {
                        element,
                        visible,
                        nearTopRight,
                        hasCloseIcon,
                        score:
                            Math.abs(modal.getBoundingClientRect().right - rect.right) +
                            Math.abs(rect.top - modal.getBoundingClientRect().top)
                    };
                }).filter(candidate =>
                    candidate.visible &&
                    candidate.nearTopRight &&
                    candidate.hasCloseIcon
                ).sort((a, b) => a.score - b.score);

                if (!closeCandidates.length) {
                    // MAL may render the X as a clickable element without a button role.
                    // Its position is near the modal's top-right corner.
                    const rect = modal.getBoundingClientRect();
                    const closeX = rect.right - rect.width * 0.06;
                    const closeY = rect.top + rect.height * 0.048;
                    const target = document.elementFromPoint(closeX, closeY);

                    if (!target || !modal.contains(target)) return false;

                    target.click();
                    return true;
                }

                closeCandidates[0].element.click();
                return true;
            });

            console.info(
                closed
                    ? 'Closed MAL privacy notice using its top-right close control.'
                    : 'MAL privacy notice close control was not identified.'
            );
            if (closed) {
                await new Promise(resolve => setTimeout(resolve, 400));
            }
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
