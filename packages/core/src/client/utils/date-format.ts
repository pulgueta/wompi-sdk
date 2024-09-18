import type { YYYYMMDD } from "@/client/transactions/types";

export const isValidYYYYMMDD = (date: string): date is YYYYMMDD =>
  /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date));

export const createYYYYMMDD = (date: Date): YYYYMMDD => {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");

  return `${year}-${month}-${day}` as YYYYMMDD;
};
