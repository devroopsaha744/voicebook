import fs from "fs";
import path from "path";

function getPresentDate(): string {
  const today = new Date();
  return today.toISOString().split("T")[0];
}

function storeOnCsv(
  name: string,
  email: string,
  bookingDate: string,
  filename: string = "bookings.csv"
): void {
  const filePath = path.resolve(filename);
  const fileExists = fs.existsSync(filePath);

  const headers = ["name", "email", "date"];
  const row = `${name},${email},${bookingDate}\n`;

  if (!fileExists) {
    fs.writeFileSync(filePath, headers.join(",") + "\n", { encoding: "utf-8" });
  }
  fs.appendFileSync(filePath, row, { encoding: "utf-8" });
}

export { getPresentDate, storeOnCsv };
