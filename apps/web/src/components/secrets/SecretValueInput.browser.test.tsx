import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { SecretValueInput } from "./SecretValueInput";

function Entry() {
  const [value, setValue] = useState("");
  return (
    <>
      <SecretValueInput aria-label="Secret value" value={value} onValueChange={setValue} />
      <output aria-label="Saved bytes">{JSON.stringify(value)}</output>
    </>
  );
}

it("retains pasted line breaks and boundary spaces, and clears them explicitly", async () => {
  // This isolated input has no navigation or environment dependencies.
  await using screen = await render(<Entry />, { router: false });
  const secret = "  first\r\nsecond\n ";
  const field = screen.getByRole("textbox", { name: "Secret value" });
  await userEvent.fill(field, "prefix ");
  const clipboard = new DataTransfer();
  clipboard.setData("text", secret);
  field
    .element()
    .dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }),
    );
  await expect
    .element(screen.getByLabelText("Saved bytes"))
    .toHaveTextContent(JSON.stringify("prefix " + secret), { normalizeWhitespace: false });
  await expect.element(field).toHaveAttribute("readonly");
  await userEvent.click(screen.getByRole("button", { name: "Clear pasted value" }));
  await expect.element(screen.getByLabelText("Saved bytes")).toHaveTextContent('""');
  await expect.element(field).not.toHaveAttribute("readonly");
});
