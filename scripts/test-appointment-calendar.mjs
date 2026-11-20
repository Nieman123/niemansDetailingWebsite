import assert from 'node:assert/strict';
import { easternStart, calendarFile, googleCalendarUrl } from '../public/scripts/appointment-utils.mjs';

assert.equal(easternStart('2027-01-18T10:30'), Date.parse('2027-01-18T15:30:00Z'));
assert.equal(easternStart('2027-07-18T10:30'), Date.parse('2027-07-18T14:30:00Z'));
assert.throws(() => easternStart('2027-03-14T02:30'), /skipped or repeated/);
assert.throws(() => easternStart('2027-11-07T01:30'), /skipped or repeated/);
const appointment = {
  service: 'Full detail; interior, exterior', address: '1 Test St\nX-CUSTOM:ignored',
  start: easternStart('2027-07-18T10:30'), end: easternStart('2027-07-18T13:30'),
  token: 'must not be included',
};
const ics = calendarFile('example', appointment, 0);
assert.match(ics, /DTSTART:20270718T143000Z\r\nDTEND:20270718T173000Z/);
assert.match(ics, /LOCATION:1 Test St\\nX-CUSTOM:ignored/);
assert.match(ics.replaceAll('\r\n ', ''), /SUMMARY:Full detail\\; interior\\, exterior/);
assert(!ics.includes(appointment.token));
const link = new URL(googleCalendarUrl(appointment));
assert.equal(link.origin, 'https://calendar.google.com');
assert.equal(link.searchParams.get('dates'), '20270718T143000Z/20270718T173000Z');
assert(!link.href.includes('token'));
console.log('PASS: Eastern wall-clock times, DST boundaries, calendar times, and calendar-safe text.');
