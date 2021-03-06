cm._lang = 'en';
cm._config.displayDateFormatCase = 'nominative';
cm._config.displayDateFormat = '%F %j, %Y';
cm._config.displayDateTimeFormat = '%F %j, %Y, %H:%i';

cm._strings = {
	'common' : {
		'server_error' : 'An unexpected error has occurred. Please try again later.'
	},
	'months' : ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
	'days' : ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
	'daysAbbr' : ['S', 'M', 'T', 'W', 'T', 'F', 'S']
};

cm.setStrings('Com.AbstractContainer', {
    'title': 'Container',
    'close': 'Close',
    'save': 'Save',
    'help': '',
});

cm.setStrings('Com.AbstractFileManagerContainer', {
	'title_single' : 'Please select a file',
	'title_multiple' : 'Please select files',
	'close' : 'Cancel',
	'save' : 'Select'
});

cm.setStrings('Com.AbstractFormField', {
	'required' : 'This field is required.',
	'too_short' : 'Value should be at least %count% characters.',
	'too_long' : 'Value should be less than %count% characters.',
	'*' : '*'
});

cm.setStrings('Com.Calendar', {
	'months' : cm._strings.months,
	'days' : cm._strings.days,
	'daysAbbr' : cm._strings.daysAbbr
});

cm.setStrings('Com.CalendarEvents', {
	'months' : cm._strings.months,
	'days' : cm._strings.days,
	'daysAbbr' : cm._strings.daysAbbr
});

cm.setStrings('Com.Dialog', {
    'closeTitle': 'Close',
    'close': '',
    'helpTitle': 'Help',
    'help': '',
});

cm.setStrings('Com.DialogContainer', {
    'close': 'Close',
});

cm.setStrings('Com.FileDropzone', {
	'drop_single' : 'drop file here',
	'drop_multiple' : 'drop files here'
});

cm.setStrings('Com.Form', {
	'form_error' : 'Form is not filled correctly.',
	'server_error' : cm._strings.common['server_error'],
	'success_message' : 'Form successfully sent'
});

cm.setStrings('Com.Gridlist', {
	'counter' : 'Count: %count%',
	'check_all' : 'Check all',
	'uncheck_all' : 'Uncheck all',
	'empty' : 'No items',
	'actions' : 'Actions'
});

cm.setStrings('Com.GridlistFilter', {
	'placeholder' : 'Type query...'
});

cm.setStrings('Com.MultipleField', {
	'add' : 'Add',
	'remove' : 'Remove'
});

cm.setStrings('Com.Notifications', {
	'close' : 'Close',
	'more' : 'Read more'
});

cm.setStrings('Com.OldBrowserAlert', {
	'title' : 'Thank you for visiting our site!',
	'descr' : 'It seems that you are using an outdated browser <strong>(%browser% %version%)</strong>. As a result, we cannot provide you with the best user experience while visiting our site. Please upgrade your <stromg>%browser%</stromg> to version <strong>%minimum_version%</strong> or above, or use another standards based browser such as Firefox, Chrome or Safari, by clicking on the icons below.',
	'continue' : 'Skip for now'
});

cm.setStrings('Com.Pagination', {
	'prev' : 'Previous',
	'next' : 'Next',
	'server_error' : cm._strings.common['server_error']
});

cm.setStrings('Com.Palette', {
	'new' : 'new',
	'previous' : 'previous',
	'select' : 'Select',
	'hue' : 'Hue',
	'opacity' : 'Opacity',
	'hex' : 'HEX'
});

cm.setStrings('Com.Request', {
	'server_error' : cm._strings.common['server_error']
});

cm.setStrings('Com.ScrollPagination', {
	'load_more' : 'Load More',
	'server_error' : cm._strings.common['server_error']
});

cm.setStrings('Com.TabsetHelper', {
	'server_error' : cm._strings.common['server_error']
});

cm.setStrings('Com.ToggleBox', {
	'show' : 'Show',
	'hide' : 'Hide'
});

cm.setStrings('Com.Autocomplete', {
	'loader' : 'Searching for <b>"%query%"</b>…',
	'suggestion' : '<b>"%query%"</b> not found. Add?'
});

cm.setStrings('Com.BoxTools', {
	'link' : 'Link',
	'unlink' : 'Unlink'
});

cm.setStrings('Com.ColorPicker', {
	'Transparent' : 'Transparent',
	'Clear' : 'Clear'
});

cm.setStrings('Com.DatePicker', {
	'months' : cm._strings.months,
	'days' : cm._strings.days,
	'daysAbbr' : cm._strings.daysAbbr,
	'Clear date' : 'Clear date',
	'Today' : 'Today',
	'Now' : 'Now',
	'Time' : 'Time:'
});

cm.setParams('Com.DatePicker', {
	'startWeekDay': 0
});

cm.setStrings('Com.DateSelect', {
	'months' : cm._strings.months,
	'Day' : 'Day',
	'Month' : 'Month',
	'Year' : 'Year'
});

cm.setStrings('Com.FileInput', {
	'browse' : 'Browse',
	'browse_local' : 'Browse Local',
	'browse_filemanager' : 'Browse File Manager',
	'remove' : 'Remove',
	'open' : 'Open'
});

cm.setStrings('Com.MultipleFileInput', {
	'browse' : 'Browse',
	'browse_local' : 'Browse Local',
	'browse_filemanager' : 'Browse File Manager'
});

cm.setStrings('Com.ImageInput', {
	'preview' : 'Preview',
	'edit' : 'Edit',
	'remove' : 'Remove',
	'browse' : 'Browse'
});

cm.setStrings('Com.RepeatTools', {
	'no-repeat' : 'No',
	'repeat-x' : 'Horizontally',
	'repeat-y' : 'Vertically',
	'repeat' : 'Both'
});

cm.setStrings('Com.ScaleTools', {
	'auto' : 'Auto',
	'contain' : 'Contain',
	'cover' : 'Cover',
	'100% 100%' : 'Fill'
});

cm.setStrings('Com.TagsInput', {
	'tags' : 'Tags',
	'add' : 'Add',
	'remove' : 'Remove',
	'placeholder' : 'Add tags...'
});

cm.setStrings('Com.TimeSelect', {
	'separator' : ':',
	'Hours' : 'HH',
	'Minutes' : 'MM',
	'Seconds' : 'SS',
	'HoursTitle' : 'Hours',
	'MinutesTitle' : 'Minutes',
	'SecondsTitle' : 'Seconds'
});

cm.setStrings('Com.TwoSideMultiSelect', {
	'firstLabel' : 'Left:',
	'secondLabel' : 'Right:',
	'add' : '>>',
	'remove' : '<<',
	'addTitle' : 'Add',
	'removeTitle' : 'Remove'
});
