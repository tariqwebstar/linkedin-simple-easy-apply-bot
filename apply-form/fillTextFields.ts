import { Page } from "puppeteer";
import fs from "fs";
import selectors from "../selectors";
import changeTextInput from "./changeTextInput";

interface TextFields {
  [labelRegex: string]: string | number;
}

async function fillTextFields(
  page: Page,
  textFields: TextFields
): Promise<void> {
  const inputs = await page.$$(selectors.textInput);
  const unansweredQuestions = []; // keep track of questions that were not answered from the textFields object

  for (const input of inputs) {
    const id = await input.evaluate((el) => el.id);
    const label = await page
      .$eval(`label[for="${id}"]`, (el) => el.innerText)
      .catch(() => "");
    let matched = false;

    for (const [labelRegex, value] of Object.entries(textFields)) {
      if (new RegExp(labelRegex, "i").test(label)) {
        await changeTextInput(input, "", value.toString());
        matched = true;
        break;
      }
    }

    if (!matched) {
      //await changeTextInput(input, "", "0"); // default to 0 if no match is found - usecase is, adding firstname to 0 too
      unansweredQuestions.push(label);
    }

    if (unansweredQuestions.length > 0) {
      // log unanswered questions to a file so use can update the textFields object in config
      fs.appendFileSync(
        "unansweredQuestions.txt",
        unansweredQuestions.join("\n") + "\n"
      );
    }
  }
}

export default fillTextFields;
