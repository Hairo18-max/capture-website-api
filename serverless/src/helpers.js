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

        // Click only the explicitly labelled Confirm button in MAL's Quantcast dialog.
        const hostname = new URL(url).hostname;
        if (hostname === 'myanimelist.net' || hostname.endsWith('.myanimelist.net')) {
            const target = await page.evaluate(() => {
                const root = document.querySelector('#qc-cmp2-container');

                if (!root) return { error: 'Quantcast container not found' };

                const controls = Array.from(root.querySelectorAll(
                    'button, [role="button"], a, [tabindex]'
                ));

                const matches = controls.filter(element => {
                    const rect = element.getBoundingClientRect();
                    const style = getComputedStyle(element);
                    const text = (element.innerText || element.textContent || '')
                        .trim().replace(/\s+/g, ' ');
                    const aria = (element.getAttribute('aria-label') || '').trim();
                    const title = (element.getAttribute('title') || '').trim();

                    return (
                        /^confirm$/i.test(text) ||
                        /^confirm$/i.test(aria) ||
                        /^confirm$/i.test(title)
                    ) &&
                    rect.width > 0 &&
                    rect.height > 0 &&
                    style.display !== 'none' &&
                    style.visibility !== 'hidden' &&
                    style.pointerEvents !== 'none';
                });

                if (matches.length !== 1) {
                    return {
                        error: matches.length
                            ? 'Multiple exact Confirm controls found'
                            : 'Exact Confirm control not found',
                        matches: matches.map(element => ({
                            tag: element.tagName,
                            text: (element.innerText || element.textContent || '')
                                .trim().slice(0, 100),
                            ariaLabel: element.getAttribute('aria-label'),
                            title: element.getAttribute('title')
                        }))
                    };
                }

                const rect = matches[0].getBoundingClientRect();

                return {
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2
                };
            });

            if (typeof target.x === 'number' && typeof target.y === 'number') {
                await page.mouse.click(target.x, target.y);
                console.info(
                    `MAL Confirm clicked: x=${target.x}, y=${target.y}`
                );
                await new Promise(resolve => setTimeout(resolve, 600));

                // Dismiss MAL's acknowledgement after Quantcast accepts the choices.
                const acknowledgement = await page.evaluate(() => {
                    const dialogs = Array.from(document.querySelectorAll(
                        '[role="dialog"], [aria-modal="true"]'
                    )).filter(dialog => {
                        const rect = dialog.getBoundingClientRect();
                        const style = getComputedStyle(dialog);
                        return rect.width > 0 &&
                            rect.height > 0 &&
                            style.display !== 'none' &&
                            style.visibility !== 'hidden';
                    });

                    const matches = dialogs.flatMap(dialog =>
                        Array.from(dialog.querySelectorAll(
                            'button, [role="button"], a, [tabindex]'
                        )).filter(element => {
                            const rect = element.getBoundingClientRect();
                            const style = getComputedStyle(element);
                            const text = (element.innerText || element.textContent || '')
                                .trim().replace(/\s+/g, ' ');
                            const aria = (element.getAttribute('aria-label') || '').trim();

                            return (
                                /^OK$/i.test(text) ||
                                /^OK$/i.test(aria)
                            ) &&
                            rect.width > 0 &&
                            rect.height > 0 &&
                            style.display !== 'none' &&
                            style.visibility !== 'hidden' &&
                            style.pointerEvents !== 'none';
                        })
                    );

                    if (matches.length !== 1) {
                        return {
                            error: matches.length
                                ? 'Multiple acknowledgement OK controls found'
                                : 'Acknowledgement OK control not found',
                            count: matches.length,
                            dialogsFound: dialogs.length
                        };
                    }

                    const rect = matches[0].getBoundingClientRect();
                    return {
                        x: rect.left + rect.width / 2,
                        y: rect.top + rect.height / 2
                    };
                });

                if (
                    typeof acknowledgement.x === 'number' &&
                    typeof acknowledgement.y === 'number'
                ) {
                    await page.mouse.click(
                        acknowledgement.x,
                        acknowledgement.y
                    );
                    console.info(
                        `MAL acknowledgement OK clicked: x=${acknowledgement.x}, y=${acknowledgement.y}`
                    );
                    await new Promise(resolve => setTimeout(resolve, 400));
                } else {
                    console.info(
                        'MAL acknowledgement not clicked: ' +
                        JSON.stringify(acknowledgement)
                    );
                }
            } else {
                console.info('MAL Confirm not clicked: ' + JSON.stringify(target));
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
