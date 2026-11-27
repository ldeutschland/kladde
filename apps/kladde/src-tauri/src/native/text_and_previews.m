#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#import <PDFKit/PDFKit.h>
#import <Vision/Vision.h>
#import "pdf_editing.h"
#import <TargetConditionals.h>
#if TARGET_OS_OSX
#import <AppKit/AppKit.h>
#else
#import <UIKit/UIKit.h>
#endif

static const size_t imageEdge = 2400;
static const NSUInteger pageLimit = 200;
static const NSUInteger searchPageLimit = 5000;
static const NSStringCompareOptions findOptions = NSCaseInsensitiveSearch | NSDiacriticInsensitiveSearch;

static NSArray<VNRecognizedTextObservation *> *recognizedLines(CGImageRef image) {
    if (!image) return nil;
    VNRecognizeTextRequest *request = [VNRecognizeTextRequest new];
    request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
    request.automaticallyDetectsLanguage = YES;
    request.recognitionLanguages = @[@"de-DE", @"en-US"];
    VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:image options:@{}];
    if (![handler performRequests:@[request] error:nil]) return nil;
    return request.results;
}

static BOOL recognize(CGImageRef image, NSMutableString *output, NSString *embedded) {
    NSArray<VNRecognizedTextObservation *> *lines = recognizedLines(image);
    if (!lines) return NO;
    for (VNRecognizedTextObservation *line in lines) {
        NSString *text = [line topCandidates:1].firstObject.string;
        if (text.length && (!embedded.length || ![embedded containsString:text])) {
            [output appendFormat:@"%@\n", [text stringByReplacingOccurrencesOfString:@"\f" withString:@" "]];
        }
    }
    return YES;
}

static CGImageRef renderPage(PDFPage *documentPage, BOOL inColor, size_t edge) {
    CGSize shown = kladde_shown_size(documentPage);
    if (!isfinite(shown.width) || !isfinite(shown.height) || shown.width <= 0 || shown.height <= 0) return NULL;
    CGFloat scale = edge / MAX(shown.width, shown.height);
    size_t width = MAX(1, round(shown.width * scale));
    size_t height = MAX(1, round(shown.height * scale));
    CGColorSpaceRef color = inColor ? CGColorSpaceCreateDeviceRGB() : CGColorSpaceCreateDeviceGray();
    CGContextRef context = CGBitmapContextCreate(NULL, width, height, 8, 0, color, inColor ? kCGImageAlphaNoneSkipLast : kCGImageAlphaNone);
    CGColorSpaceRelease(color);
    if (!context) return NULL;
    CGContextSetGrayFillColor(context, 1, 1);
    CGContextFillRect(context, CGRectMake(0, 0, width, height));
    CGContextScaleCTM(context, scale, scale);
    [documentPage drawWithBox:kPDFDisplayBoxCropBox toContext:context];
    CGImageRef image = CGBitmapContextCreateImage(context);
    CGContextRelease(context);
    return image;
}

typedef struct {
    float *boxes;
    uint32_t *places;
    size_t capacity;
    size_t count;
    uint32_t matches;
    uint32_t page;
} Found;

static BOOL isFull(const Found *into) {
    return into->count >= into->capacity;
}

static void addBox(CGRect found, CGSize whole, Found *into) {
    if (isFull(into) || whole.width <= 0 || whole.height <= 0) return;
    float *box = into->boxes + into->count * 4;
    box[0] = CGRectGetMinX(found) / whole.width;
    box[1] = 1 - CGRectGetMaxY(found) / whole.height;
    box[2] = CGRectGetWidth(found) / whole.width;
    box[3] = CGRectGetHeight(found) / whole.height;
    if (into->places) {
        into->places[into->count * 2] = into->page;
        into->places[into->count * 2 + 1] = into->matches;
    }
    into->count += 1;
}

static void textBoxes(PDFPage *page, NSString *term, Found *into) {
    CGSize shown = kladde_shown_size(page);
    CGAffineTransform toShown = [page transformForBox:kPDFDisplayBoxCropBox];
    NSString *text = page.string;
    NSRange remaining = NSMakeRange(0, text.length);
    while (!isFull(into) && remaining.length) {
        NSRange match = [text rangeOfString:term options:findOptions range:remaining];
        if (match.location == NSNotFound) break;
        for (PDFSelection *line in [page selectionForRange:match].selectionsByLine) {
            addBox(CGRectApplyAffineTransform([line boundsForPage:page], toShown), shown, into);
        }
        into->matches += 1;
        remaining = NSMakeRange(NSMaxRange(match), text.length - NSMaxRange(match));
    }
}

static void recognizedBoxes(CGImageRef image, NSString *term, Found *into) {
    for (VNRecognizedTextObservation *line in recognizedLines(image)) {
        VNRecognizedText *candidate = [line topCandidates:1].firstObject;
        NSString *text = candidate.string;
        NSRange remaining = NSMakeRange(0, text.length);
        while (!isFull(into) && remaining.length) {
            NSRange match = [text rangeOfString:term options:findOptions range:remaining];
            if (match.location == NSNotFound) break;
            VNRectangleObservation *box = [candidate boundingBoxForRange:match error:nil];
            if (box) addBox(box.boundingBox, CGSizeMake(1, 1), into);
            into->matches += 1;
            remaining = NSMakeRange(NSMaxRange(match), text.length - NSMaxRange(match));
        }
    }
}

static BOOL pageHasImages(CGPDFPageRef page) {
    CGPDFDictionaryRef node = CGPDFPageGetDictionary(page);
    CGPDFDictionaryRef resources = NULL;
    for (int depth = 0; node && depth < 32; depth++) {
        if (CGPDFDictionaryGetDictionary(node, "Resources", &resources)) break;
        if (!CGPDFDictionaryGetDictionary(node, "Parent", &node)) break;
    }
    CGPDFDictionaryRef objects = NULL;
    return resources && CGPDFDictionaryGetDictionary(resources, "XObject", &objects) && CGPDFDictionaryGetCount(objects) > 0;
}

static int extractPDF(NSData *data, NSMutableString *output, size_t capacity) {
    PDFDocument *pdf = [[PDFDocument alloc] initWithData:data];
    if (!pdf || pdf.isLocked || !pdf.allowsCopying || !pdf.pageCount) return -1;
    BOOL partial = pdf.pageCount > pageLimit;
    for (NSUInteger i = 0; i < MIN(pdf.pageCount, pageLimit); i++) {
        @autoreleasepool {
            PDFPage *page = [pdf pageAtIndex:i];
            NSString *text = [page.string stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
            if (i) [output appendString:@"\f"];
            if (text.length) [output appendFormat:@"%@\n",  [text stringByReplacingOccurrencesOfString:@"\f" withString:@" "]];
            if (output.length >= capacity) return 1;
            CGPDFPageRef pdfPage = page.pageRef;
            if (!pdfPage) {
                partial = YES;
            } else if (text.length < 32 || pageHasImages(pdfPage)) {
                CGImageRef image = renderPage(page, NO, imageEdge);
                if (!recognize(image, output, text)) partial = YES;
                if (image) CGImageRelease(image);
            }
            if (output.length >= capacity) return 1;
        }
    }
    return partial ? 1 : 0;
}

static CGImageRef imageThumbnail(CGImageSourceRef source, size_t index, size_t edge) {
    NSDictionary *props = CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(source, index, NULL));
    double width = [props[(__bridge NSString *)kCGImagePropertyPixelWidth] doubleValue];
    double height = [props[(__bridge NSString *)kCGImagePropertyPixelHeight] doubleValue];
    if (width < 1 || height < 1 || width * height > 100000000) return NULL;
    NSDictionary *options = @{(__bridge NSString *)kCGImageSourceCreateThumbnailFromImageAlways: @YES,
                              (__bridge NSString *)kCGImageSourceCreateThumbnailWithTransform: @YES,
                              (__bridge NSString *)kCGImageSourceThumbnailMaxPixelSize: @(edge)};
    return CGImageSourceCreateThumbnailAtIndex(source, index, (__bridge CFDictionaryRef)options);
}

static NSArray<NSString *> *previewTypes(void) {
    return @[@"public.png", @"public.jpeg", @"public.tiff", @"public.heic", @"public.heif",
             @"public.avif", @"org.webmproject.webp", @"com.compuserve.gif", @"com.microsoft.bmp", @"public.jpeg-2000"];
}

static BOOL isPreviewImage(CGImageSourceRef source) {
    NSString *type = (__bridge NSString *)CGImageSourceGetType(source);
    return type && [previewTypes() containsObject:type];
}

void kladde_restrict_image_types(void) {
    CGImageSourceSetAllowableTypes((__bridge CFArrayRef)previewTypes());
}

static int extractImage(NSData *data, NSMutableString *output, size_t capacity) {
    CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)data, NULL);
    if (!source) return -2;
    if (!isPreviewImage(source)) {
        CFRelease(source);
        return -2;
    }
    NSString *type = (__bridge NSString *)CGImageSourceGetType(source);
    size_t count = CGImageSourceGetCount(source);
    size_t pages = [type isEqual:@"public.tiff"] ? count : MIN(count, 1);
    BOOL partial = pages > pageLimit;
    for (size_t i = 0; i < MIN(pages, pageLimit); i++) {
        @autoreleasepool {
            if (i) [output appendString:@"\f"];
            CGImageRef image = imageThumbnail(source, i, imageEdge);
            if (!recognize(image, output, nil)) partial = YES;
            if (image) CGImageRelease(image);
            if (output.length >= capacity) {
                partial = YES;
                break;
            }
        }
    }
    CFRelease(source);
    if (!pages || (partial && !output.length)) return -1;
    return partial ? 1 : 0;
}

int kladde_recognize(const uint8_t *bytes, size_t length, bool pdf, uint8_t *buffer, size_t capacity, size_t *written) {
    @autoreleasepool {
        @try {
            NSData *data = [NSData dataWithBytesNoCopy:(void *)bytes length:length freeWhenDone:NO];
            NSMutableString *output = [NSMutableString new];
            int status = pdf ? extractPDF(data, output, capacity) : extractImage(data, output, capacity);
            if (status < 0) return status;
            NSRange rest;
            [output getBytes:buffer maxLength:capacity usedLength:written encoding:NSUTF8StringEncoding
                     options:0 range:NSMakeRange(0, output.length) remainingRange:&rest];
            return rest.length ? 1 : status;
        } @catch (NSException *exception) {
            return -1;
        }
    }
}

size_t kladde_file_preview(const uint8_t *bytes, size_t length, size_t index, bool pdf, size_t edge, void *result,
                           void (*copy)(void *, const uint8_t *, size_t)) {
    if (!edge || edge > imageEdge) return 0;
    @autoreleasepool {
        @try {
            NSData *data = [NSData dataWithBytesNoCopy:(void *)bytes length:length freeWhenDone:NO];
            CGImageRef image = NULL;
            size_t count;
            if (pdf) {
                PDFDocument *document = [[PDFDocument alloc] initWithData:data];
                count = document.pageCount;
                if (document.isLocked || index >= count) return 0;
                PDFPage *page = [document pageAtIndex:index];
                if (page.pageRef) image = renderPage(page, YES, edge);
            } else {
                CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)data, NULL);
                if (!source) return 0;
                count = isPreviewImage(source) ? CGImageSourceGetCount(source) : 0;
                if (index < count) image = imageThumbnail(source, index, edge);
                CFRelease(source);
            }
            if (!image) return 0;
            NSMutableData *jpeg = [NSMutableData data];
            CGImageDestinationRef dest = CGImageDestinationCreateWithData((__bridge CFMutableDataRef)jpeg, CFSTR("public.jpeg"), 1, NULL);
            if (dest) {
                NSDictionary *quality = @{(__bridge NSString *)kCGImageDestinationLossyCompressionQuality: @0.92};
                CGImageDestinationAddImage(dest, image, (__bridge CFDictionaryRef)quality);
                BOOL ready = CGImageDestinationFinalize(dest);
                CFRelease(dest);
                if (ready) copy(result, jpeg.bytes, jpeg.length);
            }
            CGImageRelease(image);
            return count;
        } @catch (NSException *exception) {
            return 0;
        }
    }
}

size_t kladde_find_boxes(const uint8_t *bytes, size_t length, size_t index, bool pdf, const char *term, float *boxes,
                         size_t capacity) {
    @autoreleasepool {
        @try {
            NSString *wanted = [NSString stringWithUTF8String:term];
            if (!wanted.length || !capacity) return 0;
            NSData *data = [NSData dataWithBytesNoCopy:(void *)bytes length:length freeWhenDone:NO];
            Found into = {boxes, NULL, capacity, 0, 0, 0};
            CGImageRef image = NULL;
            if (pdf) {
                PDFDocument *document = [[PDFDocument alloc] initWithData:data];
                if (!document || document.isLocked || index >= document.pageCount) return 0;
                PDFPage *page = [document pageAtIndex:index];
                textBoxes(page, wanted, &into);
                if (into.count || !page.pageRef) return into.count;
                image = renderPage(page, NO, imageEdge);
            } else {
                CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)data, NULL);
                if (!source) return 0;
                if (isPreviewImage(source) && index < CGImageSourceGetCount(source)) image = imageThumbnail(source, index, imageEdge);
                CFRelease(source);
            }
            recognizedBoxes(image, wanted, &into);
            if (image) CGImageRelease(image);
            return into.count;
        } @catch (NSException *exception) {
            return 0;
        }
    }
}

static BOOL mentions(NSString *text, NSString *term) {
    return text && [text rangeOfString:term options:findOptions].location != NSNotFound;
}

static NSArray<NSString *> *indexedPages(const uint8_t *known, size_t length, size_t pages) {
    if (!pages) return @[];
    NSString *text = known && length ? [[NSString alloc] initWithBytes:known length:length encoding:NSUTF8StringEncoding] : @"";
    NSArray<NSString *> *segments = [text componentsSeparatedByString:@"\f"];
    if (!segments) return @[];
    return [segments subarrayWithRange:NSMakeRange(0, MIN(pages, segments.count))];
}

static void markPage(Found *into) {
    addBox(CGRectZero, CGSizeMake(1, 1), into);
    into->matches += 1;
}

static void recognizedPage(PDFPage *page, NSString *term, Found *into) {
    if (!page.pageRef) return;
    CGImageRef image = renderPage(page, NO, imageEdge);
    recognizedBoxes(image, term, into);
    if (image) CGImageRelease(image);
}

static void findInPDF(NSData *data, NSString *term, NSArray<NSString *> *indexed, Found *into) {
    PDFDocument *document = [[PDFDocument alloc] initWithData:data];
    if (!document || document.isLocked) return;
    NSUInteger pages = MIN(document.pageCount, searchPageLimit);
    for (NSUInteger index = 0; index < pages && !isFull(into); index++) {
        @autoreleasepool {
            BOOL known = index < indexed.count;
            if (known && !mentions(indexed[index], term)) continue;
            uint32_t before = into->matches;
            PDFPage *page = [document pageAtIndex:index];
            into->page = (uint32_t)index;
            textBoxes(page, term, into);
            if (into->matches > before || !known) continue;
            recognizedPage(page, term, into);
            if (into->matches == before) markPage(into);
        }
    }
}

static void findInImage(NSData *data, NSString *term, NSArray<NSString *> *indexed, Found *into) {
    BOOL known = indexed.count > 0;
    if (known && !mentions(indexed[0], term)) return;
    CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)data, NULL);
    if (!source) return;
    BOOL readable = isPreviewImage(source) && CGImageSourceGetCount(source) > 0;
    CGImageRef image = readable ? imageThumbnail(source, 0, imageEdge) : NULL;
    CFRelease(source);
    recognizedBoxes(image, term, into);
    if (image) CGImageRelease(image);
    if (known && !into->matches) markPage(into);
}

size_t kladde_find_all(const uint8_t *bytes, size_t length, bool pdf, const char *term, const uint8_t *known,
                       size_t knownLength, size_t knownPages, uint32_t *places, float *boxes, size_t capacity) {
    @autoreleasepool {
        @try {
            NSString *wanted = [NSString stringWithUTF8String:term];
            if (!wanted.length || !capacity) return 0;
            NSArray<NSString *> *indexed = indexedPages(known, knownLength, knownPages);
            NSData *data = [NSData dataWithBytesNoCopy:(void *)bytes length:length freeWhenDone:NO];
            Found into = {boxes, places, capacity, 0, 0, 0};
            if (pdf) findInPDF(data, wanted, indexed, &into);
            else findInImage(data, wanted, indexed, &into);
            return into.count;
        } @catch (NSException *exception) {
            return 0;
        }
    }
}

void kladde_open_source(const char *address) {
    NSURL *url = [NSURL URLWithString:[NSString stringWithUTF8String:address]];
    if (!url) return;
    dispatch_async(dispatch_get_main_queue(), ^{
#if TARGET_OS_OSX
        [[NSWorkspace sharedWorkspace] openURL:url];
#else
        [[UIApplication sharedApplication] openURL:url options:@{} completionHandler:nil];
#endif
    });
}
