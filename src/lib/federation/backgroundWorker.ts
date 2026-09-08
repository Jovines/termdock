import { renewBackgroundSubscriptions, reportBackgroundNotificationClick, flushBackgroundNotificationLogs } from './backgroundNotifications';
Object.assign(globalThis, { termdockBackground: { renewSubscriptions: renewBackgroundSubscriptions, reportClick: reportBackgroundNotificationClick, flushLogs: flushBackgroundNotificationLogs } });
