// Shared by the browser and Worker. Notice is calendar days in Austin, not 72 hours.
export const TIMEZONE = 'America/Chicago';
export const HOURS_TEXT = 'Hours are 8:00 AM to 6:30 PM on weekdays and 8:00 AM to 12:00 PM on weekends.';
const dateFormatter = new Intl.DateTimeFormat('en-CA', {timeZone:TIMEZONE,year:'numeric',month:'2-digit',day:'2-digit'});
const clockFormatter = new Intl.DateTimeFormat('en-GB', {timeZone:TIMEZONE,hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
export const localDate = timestamp => dateFormatter.format(new Date(timestamp));
export function addDays(day, count) { return new Date(Date.parse(day+'T12:00:00Z')+count*86400000).toISOString().slice(0,10); }
export function bookingWindow(now=Date.now()) { const today=localDate(now);return {first:addDays(today,3),last:addDays(today,28)}; }
export function withinHours(start) {
  if(!Number.isFinite(start))return false;
  const day=localDate(start), weekday=new Date(day+'T12:00:00Z').getUTCDay();
  const time=clockFormatter.format(new Date(start));
  return time>='08:00' && time<=([0,6].includes(weekday)?'12:00':'18:30');
}
export function bookableStart(start,now=Date.now()) {
  if(!Number.isFinite(start)||start%60000!==0)return false;
  const day=localDate(start),window=bookingWindow(now);
  return day>=window.first && day<=window.last && withinHours(start);
}
