importScripts('./schedule-core.js?v=3');

self.onmessage = function (e) {
    const { coursesSections, options } = e.data || {};
    const result = self.ScheduleCore.solveSchedules(coursesSections, options);
    self.postMessage(result);
};
