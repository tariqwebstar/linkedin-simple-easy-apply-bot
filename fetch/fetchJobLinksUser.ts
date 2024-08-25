import { ElementHandle, Page } from "puppeteer";
import LanguageDetect from "languagedetect";

import buildUrl from "../utils/buildUrl";
import wait from "../utils/wait";
import selectors from "../selectors";

const MAX_PAGE_SIZE = 7;
const languageDetector = new LanguageDetect();

async function getJobSearchMetadata({
  page,
  location,
  keywords,
}: {
  page: Page;
  location: string;
  keywords: string;
}) {
  await page.goto("https://linkedin.com/jobs", { waitUntil: "load" });

  await page.type(selectors.keywordInput, keywords);
  await page.waitForSelector(selectors.locationInput, { visible: true });
  await page.$eval(
    selectors.locationInput,
    (el, location) => ((el as HTMLInputElement).value = location),
    location
  );
  await page.type(selectors.locationInput, " ");
  await page.$eval("button.jobs-search-box__submit-button", (el) => el.click());
  await page.waitForFunction(() =>
    new URLSearchParams(document.location.search).has("geoId")
  );

  const geoId = await page.evaluate(() =>
    new URLSearchParams(document.location.search).get("geoId")
  );

  const numJobsHandle = (await page.waitForSelector(
    selectors.searchResultListText,
    { timeout: 5000 }
  )) as ElementHandle<HTMLElement>;
  const numAvailableJobs = await numJobsHandle.evaluate((el) =>
    parseInt((el as HTMLElement).innerText.replace(",", ""))
  );

  return {
    geoId,
    numAvailableJobs,
  };
}

export type date_posted = "PAST_WEEK" | "PAST_MONTH" | "PAST_24_HOURS";

const datesPosted: Record<date_posted, string> = {
  PAST_WEEK: "r604800",
  PAST_MONTH: "r2592000",
  PAST_24_HOURS: "r86400",
};

interface PARAMS {
  page: Page;
  location: string;
  keywords: string;
  workplace: { remote: boolean; onSite: boolean; hybrid: boolean };
  datePosted: date_posted | null;
  jobTitle: string;
  jobTitleExcluded: string;
  jobDescription: string;
  jobDescriptionLanguages: string[];
  mode: string;
}

/**
 * Fetches job links as a user (logged in)
 */
async function* fetchJobLinksUser({
  page,
  location,
  keywords,
  workplace: { remote, onSite, hybrid },
  datePosted = null,
  jobTitle,
  jobTitleExcluded,
  jobDescription,
  jobDescriptionLanguages,
  mode,
}: PARAMS): AsyncGenerator<[string, string, string]> {
  let numSeenJobs = 0;
  let numMatchingJobs = 0;
  const fWt = [onSite, remote, hybrid]
    .reduce((acc, c, i) => (c ? [...acc, i + 1] : acc), [] as number[])
    .join(",");

  const { geoId, numAvailableJobs } = await getJobSearchMetadata({
    page,
    location,
    keywords,
  });

  const searchParams: { [key: string]: string } = {
    keywords,
    location,
    start: numSeenJobs.toString(),
    f_WT: fWt,
    f_AL: "true",
    ...(datePosted && {
      f_TPR: datesPosted[datePosted],
    }),
  };

  if (geoId) {
    searchParams.geoId = geoId.toString();
  }

  const url = buildUrl("https://www.linkedin.com/jobs/search", searchParams);

  const jobTitleRegExp = new RegExp(jobTitle, "i");
  const jobTitleExcludedRegExp = new RegExp(jobTitleExcluded, "i");
  const jobDescriptionRegExp = new RegExp(jobDescription, "i");
  const companies: string[] = [];

  while (numSeenJobs < numAvailableJobs) {
    //while (numSeenJobs < numAvailableJobs) {
    url.searchParams.set("start", numSeenJobs.toString());

    await page.goto(url.toString(), { waitUntil: "load" });

    await page.waitForSelector(
      `${selectors.searchResultListItem}:nth-child(${Math.min(
        MAX_PAGE_SIZE,
        numAvailableJobs - numSeenJobs
      )})`,
      { timeout: 5000 }
    );

    const jobListings = await page.$$(selectors.searchResultListItem);

    //for (let i = 0; i < 1; i++) {
    for (let i = 0; i < Math.min(jobListings.length, MAX_PAGE_SIZE); i++) {
      try {
        const [link, title] = await page.$eval(
          `${selectors.searchResultListItem}:nth-child(${i + 1}) ${
            selectors.searchResultListItemLink
          }`,
          (el) => {
            const linkEl = el as HTMLLinkElement;
            linkEl.click();

            // Select the visible span for the title
            const visibleSpan = linkEl.querySelector(
              'span[aria-hidden="true"]'
            ) as HTMLElement;
            const titleText = visibleSpan ? visibleSpan.innerText.trim() : "";

            return [linkEl.href.trim(), titleText];
          }
        );

        await page.waitForFunction(
          async (selectors) => {
            const hasLoadedDescription = !!document
              .querySelector<HTMLElement>(selectors.jobDescription)
              ?.innerText.trim();
            const hasLoadedStatus = !!(
              document.querySelector(selectors.easyApplyButtonEnabled) ||
              document.querySelector(selectors.appliedToJobFeedback)
            );
            return hasLoadedStatus && hasLoadedDescription;
          },
          {},
          selectors
        );

        const companyName = await page
          .$eval(
            `${selectors.searchResultListItem}:nth-child(${i + 1}) ${
              selectors.searchResultListItemCompanyName
            }`,
            (el) => (el as HTMLElement).innerText
          )
          .catch(() => "Unknown");

        const jobDescription = await page.$eval(
          selectors.jobDescription,
          (el) => (el as HTMLElement).innerText
        );
        const canApply = !!(await page.$(selectors.easyApplyButtonEnabled));
        const jobDescriptionLanguage = languageDetector.detect(
          jobDescription,
          1
        )[0][0];
        const matchesLanguage =
          jobDescriptionLanguages.includes("any") ||
          jobDescriptionLanguages.includes(jobDescriptionLanguage);

        // console.log([
        //   { canApply: canApply },
        //   { jobTitleRegExp: jobTitleRegExp.test(title) },
        //   { jobTitleExcludedRegExp: !jobTitleExcludedRegExp.test(title) },
        //   { jobDescriptionRegExp: jobDescriptionRegExp.test(jobDescription) },
        //   { matchesLanguage: matchesLanguage },
        //   { companyName: companyName },
        //   { title: title },
        // ]);

        const isCompamyFound = companies.find((x) => x === companyName);
        if (!isCompamyFound) {
          if (mode === "strict") {
            if (
              canApply &&
              jobTitleRegExp.test(title) &&
              !jobTitleExcludedRegExp.test(title) &&
              jobDescriptionRegExp.test(jobDescription) &&
              matchesLanguage
            ) {
              numMatchingJobs++;

              yield [link, title, companyName];
            }
          } else {
            if (canApply) {
              numMatchingJobs++;

              yield [link, title, companyName];
            }
          }
        }
        companies.push(companyName);
      } catch (e) {
        console.log(e);
      }
    }

    await wait(2000);

    numSeenJobs += jobListings.length;
  }
}

export default fetchJobLinksUser;
