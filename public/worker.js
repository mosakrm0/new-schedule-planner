importScripts('./schedule-core.js?v=4');

self.onmessage = function (e) {
    const { coursesSections, options } = e.data || {};
    const result = self.ScheduleCore.solveSchedules(coursesSections, options);
    self.postMessage(result);
};
